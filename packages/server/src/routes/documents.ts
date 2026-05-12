import { Hono } from "hono";
import { eq, desc, and, sql, ilike } from "drizzle-orm";
import { createHash } from "node:crypto";
import { renderMarkdown } from "@sideways/markdown";
import {
  type Database,
  documents,
  documentVersions,
  documentReads,
  documentWatches,
  notifications,
  sections,
  spaces,
  themes,
  users,
} from "@sideways/db";
import type { Storage } from "@sideways/storage";
import type { AuthUser } from "../middleware/auth.js";
import { canAccessSpace, canWriteSpace } from "../middleware/visibility.js";
import { buildPrintHTML, type ThemeTokens } from "../pdf/template.js";
import { env } from "../env.js";
import { validateTitle, validateSlug, validateTags, validateContent } from "../middleware/validate.js";
import { notifyWatchers, notifySpaceWatchers } from "../lib/notify.js";

async function ensureSystemUser(db: Database): Promise<string> {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, "system@sideways.local"),
  });
  if (existing) return existing.id;

  const [user] = await db
    .insert(users)
    .values({ email: "system@sideways.local", name: "System" })
    .returning();
  return user.id;
}

/** Extract title from markdown: first # heading, or null */
function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/** Recompute the full-text search index for a document */
async function updateSearchIndex(db: Database, docId: string, title: string, tags: string[], content: string) {
  await db.execute(sql`
    UPDATE documents SET search_tsv =
      setweight(to_tsvector('english', ${title}), 'A') ||
      setweight(to_tsvector('english', ${tags.join(" ")}), 'B') ||
      setweight(to_tsvector('english', ${content}), 'C')
    WHERE id = ${docId}
  `);
}

/** Get the current user's ID, or fall back to system user */
async function getUserId(
  c: { get: (key: string) => any },
  db: Database,
): Promise<string> {
  const user = c.get("user") as AuthUser | null;
  if (user) return user.id;
  return ensureSystemUser(db);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function createDocumentRoutes(db: Database, storage: Storage) {
  const router = new Hono();

  /** Find a space and check read access. Returns space or error response. */
  async function resolveSpace(c: any, spaceSlug: string) {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, spaceSlug),
    });
    if (!space) return { error: c.json({ error: "Space not found" }, 404) };

    const user = c.get("user") as AuthUser | null;
    const allowed = await canAccessSpace(
      db, space.id, space.visibility, space.ownerId, user,
    );
    if (!allowed) return { error: c.json({ error: "Forbidden" }, 403) };

    return { space };
  }

  /** List all documents, optionally filtered by space */
  router.get("/", async (c) => {
    const spaceSlug = c.req.query("space");

    if (spaceSlug) {
      const result = await resolveSpace(c, spaceSlug);
      if ("error" in result) return result.error;
      const { space } = result;

      const docs = await db.query.documents.findMany({
        where: eq(documents.spaceId, space.id),
        orderBy: [documents.position, documents.title],
      });

      // Annotate with unread status if user is authenticated
      const user = c.get("user") as AuthUser | null;
      if (user) {
        const reads = await db.query.documentReads.findMany({
          where: eq(documentReads.userId, user.id),
        });
        const readMap = new Map(reads.map(r => [r.documentId, r.readAt]));
        return c.json(docs.map(d => ({
          ...d,
          unread: !readMap.has(d.id) || readMap.get(d.id)! < d.updatedAt,
        })));
      }

      return c.json(docs);
    }

    const docs = await db.query.documents.findMany({
      orderBy: [documents.position, documents.title],
    });
    return c.json(docs);
  });

  /** Get sync metadata for all docs in a space (slug, version, hash) */
  router.get("/:space/_sync", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    // Optional section filter
    const sectionSlug = c.req.query("section");
    let sectionId: string | null = null;
    if (sectionSlug) {
      const section = await db.query.sections.findFirst({
        where: and(
          eq(sections.spaceId, space.id),
          eq(sections.slug, sectionSlug),
        ),
      });
      if (section) sectionId = section.id;
    }

    const whereClause = sectionId
      ? and(eq(documents.spaceId, space.id), eq(documents.sectionId, sectionId))
      : sectionSlug
        ? and(eq(documents.spaceId, space.id), eq(documents.sectionId, sectionId)) // no match — empty
        : eq(documents.spaceId, space.id);

    const docs = await db.query.documents.findMany({
      where: whereClause,
      orderBy: [documents.position, documents.title],
    });

    const syncInfo = await Promise.all(
      docs.map(async (doc) => {
        const latest = await db.query.documentVersions.findFirst({
          where: eq(documentVersions.documentId, doc.id),
          orderBy: desc(documentVersions.version),
          columns: { version: true, contentHash: true },
        });
        return {
          slug: doc.slug,
          title: doc.title,
          version: latest?.version ?? 0,
          contentHash: latest?.contentHash ?? "",
          updatedAt: doc.updatedAt.toISOString(),
        };
      }),
    );

    return c.json(syncInfo);
  });

  /** Comment counts per document in a space */
  router.get("/:space/_comment-counts", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const rows = await db.execute(sql`
      SELECT d.slug, COUNT(c.id)::int as count
      FROM documents d
      LEFT JOIN comments c ON c.document_id = d.id AND c.resolved = false
      WHERE d.space_id = ${space.id}
      GROUP BY d.slug
      HAVING COUNT(c.id) > 0
    `);

    return c.json(rows);
  });

  /** Autocomplete: fast prefix search on doc titles/slugs within a space */
  router.get("/:space/_autocomplete", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const q = (c.req.query("q") || "").toLowerCase();
    const docs = await db.query.documents.findMany({
      where: eq(documents.spaceId, space.id),
      columns: { slug: true, title: true },
      orderBy: [documents.title],
    });

    const filtered = q
      ? docs.filter(d => d.title.toLowerCase().includes(q) || d.slug.includes(q))
      : docs;

    return c.json(filtered.slice(0, 15));
  });

  /** Get a document by space/slug */
  router.get("/:space/:slug", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });

    return c.json({ ...doc, content: latestVersion?.content ?? "" });
  });

  /** Preview: render arbitrary markdown without saving */
  router.post("/:space/:slug/render", async (c) => {
    const body = await c.req.json<{ content: string }>();
    const target = c.req.query("target") === "pdf" ? "pdf" : "web";
    const spaceSlug = c.req.param("space");
    const html = await renderMarkdown(body.content || "", { target, spaceSlug });
    return c.json({ html });
  });

  /** Get a document rendered as HTML */
  router.get("/:space/:slug/render", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });
    if (!latestVersion) return c.json({ error: "No versions" }, 404);

    // Count total versions for display
    const allVersions = await db.query.documentVersions.findMany({
      where: eq(documentVersions.documentId, doc.id),
      columns: { id: true },
    });

    const versionInfo = {
      version: latestVersion.version,
      versionCount: allVersions.length,
      versionDate: latestVersion.createdAt,
    };

    const cacheKey = `/rendered/${doc.id}/${latestVersion.contentHash}.html`;
    if (latestVersion.renderedKey) {
      try {
        const cached = await storage.download(latestVersion.renderedKey);
        const html = await cached.text();
        return c.json({ ...doc, ...versionInfo, html, content: undefined });
      } catch {
        // Cache miss, re-render
      }
    }

    const target = c.req.query("target") === "pdf" ? "pdf" : "web";
    const spaceSlug = c.req.param("space");
    const html = await renderMarkdown(latestVersion.content, { target, spaceSlug });

    storage
      .upload(cacheKey, Buffer.from(html), "text/html")
      .then(() =>
        db
          .update(documentVersions)
          .set({ renderedKey: cacheKey })
          .where(eq(documentVersions.id, latestVersion.id)),
      )
      .catch(() => {});

    return c.json({ ...doc, ...versionInfo, html, content: undefined });
  });

  /** Create or update a document in a space */
  router.put("/:space/:slug", async (c) => {
    const spaceSlug = c.req.param("space");
    const slug = c.req.param("slug");
    const body = await c.req.json<{
      title?: string;
      content?: string;
      tags?: string[];
      position?: number;
      sectionSlug?: string;
      parentSlug?: string;
      updatedAt?: string;
    }>();

    // Validate inputs
    const slugErr = validateSlug(slug);
    if (slugErr) return c.json({ error: slugErr }, 400);
    if (body.title) {
      const titleErr = validateTitle(body.title);
      if (titleErr) return c.json({ error: titleErr }, 400);
    }
    if (body.tags) {
      const tagsErr = validateTags(body.tags);
      if (tagsErr) return c.json({ error: tagsErr }, 400);
    }
    if (body.content) {
      const contentErr = validateContent(body.content);
      if (contentErr) return c.json({ error: contentErr }, 400);
    }

    const userId = await getUserId(c, db);
    const hasContent = body.content !== undefined;
    const content = body.content ?? "";
    const hash = hasContent ? contentHash(content) : null;

    // Find or create space
    let space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, spaceSlug),
    });
    if (!space) {
      [space] = await db
        .insert(spaces)
        .values({
          slug: spaceSlug,
          name: spaceSlug,
          visibility: "private",
          ownerId: userId,
        })
        .returning();
    }

    // Resolve section slug to ID if provided
    let sectionId: string | null | undefined = undefined;
    if (body.sectionSlug) {
      const section = await db.query.sections.findFirst({
        where: and(eq(sections.spaceId, space.id), eq(sections.slug, body.sectionSlug)),
      });
      if (section) sectionId = section.id;
    }

    // Resolve parent doc slug to ID if provided
    let parentId: string | null | undefined = undefined;
    if (body.parentSlug) {
      const parent = await db.query.documents.findFirst({
        where: and(eq(documents.spaceId, space.id), eq(documents.slug, body.parentSlug)),
      });
      if (parent) parentId = parent.id;
    }

    const existing = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, slug),
      ),
    });

    // Derive title: explicit > extracted from content > existing > slug
    const derivedTitle = body.title || (hasContent ? extractTitle(content) : null);

    if (existing) {
      const updates: Record<string, any> = {
        title: derivedTitle ?? existing.title,
        tags: body.tags ?? existing.tags,
        position: body.position ?? existing.position,
        updatedAt: body.updatedAt ? new Date(body.updatedAt) : new Date(),
      };
      if (sectionId !== undefined) updates.sectionId = sectionId;
      if (parentId !== undefined) updates.parentId = parentId;

      const [updated] = await db
        .update(documents)
        .set(updates)
        .where(eq(documents.id, existing.id))
        .returning();

      // Only create a new version if content was explicitly provided
      if (hasContent) {
        const latest = await db.query.documentVersions.findFirst({
          where: eq(documentVersions.documentId, existing.id),
          orderBy: desc(documentVersions.version),
        });

        if (!latest || latest.contentHash !== hash) {
          await db.insert(documentVersions).values({
            documentId: existing.id,
            version: (latest?.version ?? 0) + 1,
            title: body.title ?? existing.title,
            content,
            contentHash: hash!,
            createdBy: userId,
          });

          // Notify watchers of update (async)
          const actor = c.get("user") as AuthUser | null;
          const excludeId = actor?.actorName ? "" : userId; // agents don't exclude owner
          notifyWatchers(db, existing.id, excludeId, {
            type: "doc_updated",
            spaceSlug,
            docSlug: slug,
            title: `${updated.title} was updated`,
            actorName: actor?.displayName,
          }).then(async () => {
            // Also notify space watchers (excluding doc watchers already notified)
            const docWatchers = await db.query.documentWatches.findMany({
              where: eq(documentWatches.documentId, existing.id),
            });
            await notifySpaceWatchers(db, space.id, existing.id, excludeId, docWatchers.map(w => w.userId), {
              type: "doc_updated",
              spaceSlug,
              docSlug: slug,
              title: `${updated.title} was updated`,
              actorName: actor?.displayName,
            });
          }).catch(() => {});
        }
      }

      // Update search index (title/tags/content may have changed)
      updateSearchIndex(db, existing.id, updated.title, updated.tags || [], content).catch(() => {});

      return c.json(updated, 200);
    }

    const insertValues: Record<string, any> = {
      spaceId: space.id,
      slug,
      title: derivedTitle || slug,
      tags: body.tags ?? [],
      position: body.position ?? 0,
    };
    if (sectionId) insertValues.sectionId = sectionId;
    if (parentId) insertValues.parentId = parentId;

    const [doc] = await db
      .insert(documents)
      .values(insertValues)
      .returning();

    await db.insert(documentVersions).values({
      documentId: doc.id,
      version: 1,
      title: doc.title,
      content,
      contentHash: hash || contentHash(content),
      createdBy: userId,
    });

    // Index for search
    updateSearchIndex(db, doc.id, doc.title, doc.tags || [], content).catch(() => {});

    // Notify space watchers of new doc (async)
    const actor = c.get("user") as AuthUser | null;
    const excludeId = actor?.actorName ? "" : userId;
    notifySpaceWatchers(db, space.id, doc.id, excludeId, [], {
      type: "doc_created",
      spaceSlug,
      docSlug: slug,
      title: `${doc.title} was created`,
      actorName: actor?.displayName,
    }).catch(() => {});

    return c.json(doc, 201);
  });

  /** Delete a document — requires write access */
  router.delete("/:space/:slug", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const user = c.get("user") as AuthUser | null;
    const canWrite = await canWriteSpace(db, space.id, space.ownerId, user);
    if (!canWrite) return c.json({ error: "Forbidden" }, 403);

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    await db.delete(documents).where(eq(documents.id, doc.id));
    return c.json({ deleted: true });
  });

  /** List versions */
  router.get("/:space/:slug/versions", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const versions = await db.query.documentVersions.findMany({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
      columns: {
        id: true,
        version: true,
        title: true,
        contentHash: true,
        createdAt: true,
      },
    });

    return c.json(versions);
  });

  /**
   * PATCH /:space/:slug — partial update (rename, move, reorder)
   * Unlike PUT, this never touches content/versions.
   */
  router.patch("/:space/:slug", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const user = c.get("user") as AuthUser | null;
    const canWrite = await canWriteSpace(db, space.id, space.ownerId, user);
    if (!canWrite) return c.json({ error: "Forbidden" }, 403);

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{
      title?: string;
      slug?: string;
      tags?: string[];
      position?: number;
      space?: string;
      section?: string | null;
      parent?: string | null;
    }>();

    const updates: Record<string, any> = {};

    if (body.title !== undefined) updates.title = body.title;
    if (body.tags !== undefined) updates.tags = body.tags;
    if (body.position !== undefined) updates.position = body.position;
    if (body.parent !== undefined) {
      if (body.parent === null) {
        updates.parentId = null;
      } else {
        const parentDoc = await db.query.documents.findFirst({
          where: and(eq(documents.spaceId, space.id), eq(documents.slug, body.parent)),
        });
        if (!parentDoc) return c.json({ error: "Parent document not found" }, 404);
        updates.parentId = parentDoc.id;
      }
    }
    if (body.section !== undefined) {
      if (body.section === null) {
        updates.sectionId = null;
      } else {
        const section = await db.query.sections.findFirst({
          where: and(
            eq(sections.spaceId, space.id),
            eq(sections.slug, body.section),
          ),
        });
        if (!section) return c.json({ error: "Section not found" }, 404);
        updates.sectionId = section.id;
      }
    }

    // Rename (slug change)
    if (body.slug && body.slug !== doc.slug) {
      const newSlug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      const existing = await db.query.documents.findFirst({
        where: and(eq(documents.spaceId, space.id), eq(documents.slug, newSlug)),
      });
      if (existing) return c.json({ error: `Slug "${newSlug}" already exists in this space` }, 409);
      updates.slug = newSlug;
    }

    // Move to different space
    if (body.space && body.space !== c.req.param("space")) {
      const targetSpace = await db.query.spaces.findFirst({
        where: eq(spaces.slug, body.space),
      });
      if (!targetSpace) return c.json({ error: "Target space not found" }, 404);

      const targetCanWrite = await canWriteSpace(db, targetSpace.id, targetSpace.ownerId, user);
      if (!targetCanWrite) return c.json({ error: "Forbidden: no write access to target space" }, 403);

      // Check slug uniqueness in target
      const slugInTarget = updates.slug || doc.slug;
      const existing = await db.query.documents.findFirst({
        where: and(eq(documents.spaceId, targetSpace.id), eq(documents.slug, slugInTarget)),
      });
      if (existing) return c.json({ error: `Slug "${slugInTarget}" already exists in target space` }, 409);

      updates.spaceId = targetSpace.id;
      updates.sectionId = null; // Clear section on cross-space move
    }

    if (Object.keys(updates).length === 0) {
      return c.json(doc, 200);
    }

    updates.updatedAt = new Date();
    const [updated] = await db
      .update(documents)
      .set(updates)
      .where(eq(documents.id, doc.id))
      .returning();

    // Reindex if title or tags changed
    if (body.title !== undefined || body.tags !== undefined) {
      const latestVersion = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.documentId, doc.id),
        orderBy: desc(documentVersions.version),
        columns: { content: true },
      });
      updateSearchIndex(db, doc.id, updated.title, updated.tags || [], latestVersion?.content || "").catch(() => {});
    }

    return c.json(updated);
  });

  /**
   * POST /:space/:slug/duplicate — copy a document
   */
  router.post("/:space/:slug/duplicate", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{
      targetSpace?: string;
      targetSlug?: string;
      targetSection?: string;
    }>().catch(() => ({}));

    const userId = await getUserId(c, db);

    // Determine target space
    let targetSpaceId = space.id;
    let targetOwnerId = space.ownerId;
    if (body.targetSpace && body.targetSpace !== c.req.param("space")) {
      const ts = await db.query.spaces.findFirst({
        where: eq(spaces.slug, body.targetSpace),
      });
      if (!ts) return c.json({ error: "Target space not found" }, 404);

      const user = c.get("user") as AuthUser | null;
      if (!await canWriteSpace(db, ts.id, ts.ownerId, user)) {
        return c.json({ error: "No write access to target space" }, 403);
      }

      targetSpaceId = ts.id;
      targetOwnerId = ts.ownerId;
    }

    // Generate unique slug
    let targetSlug = body.targetSlug || `${doc.slug}-copy`;
    targetSlug = targetSlug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    let attempt = 0;
    while (true) {
      const slug = attempt === 0 ? targetSlug : `${targetSlug}-${attempt}`;
      const existing = await db.query.documents.findFirst({
        where: and(eq(documents.spaceId, targetSpaceId), eq(documents.slug, slug)),
      });
      if (!existing) { targetSlug = slug; break; }
      attempt++;
      if (attempt > 20) return c.json({ error: "Could not find unique slug" }, 409);
    }

    // Get latest content
    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });

    const content = latestVersion?.content || "";

    // Create the duplicate
    const [newDoc] = await db
      .insert(documents)
      .values({
        spaceId: targetSpaceId,
        slug: targetSlug,
        title: `${doc.title} (copy)`,
        tags: doc.tags,
        position: doc.position + 1,
      })
      .returning();

    await db.insert(documentVersions).values({
      documentId: newDoc.id,
      version: 1,
      title: newDoc.title,
      content,
      contentHash: contentHash(content),
      createdBy: userId,
    });

    return c.json(newDoc, 201);
  });

  /**
   * POST /:space/_reorder — bulk reorder documents
   * Body: [{ slug, position }]
   */
  router.post("/:space/_reorder", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const user = c.get("user") as AuthUser | null;
    const canWrite = await canWriteSpace(db, space.id, space.ownerId, user);
    if (!canWrite) return c.json({ error: "Forbidden" }, 403);

    const items = await c.req.json<{ slug: string; position: number }[]>();

    for (const item of items) {
      await db
        .update(documents)
        .set({ position: item.position, updatedAt: new Date() })
        .where(
          and(eq(documents.spaceId, space.id), eq(documents.slug, item.slug)),
        );
    }

    return c.json({ reordered: items.length });
  });

  /** Export a document as PDF */
  router.get("/:space/:slug/pdf", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });
    if (!latestVersion) return c.json({ error: "No versions" }, 404);

    // Render markdown to HTML with pdf target
    const spaceSlug = c.req.param("space");
    const html = await renderMarkdown(latestVersion.content, { target: "pdf", spaceSlug });

    // Resolve theme: explicit ?theme=<id|name> overrides the space's theme
    let theme: ThemeTokens | undefined;
    const themeOverride = c.req.query("theme");
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

    let themeRow: typeof themes.$inferSelect | undefined;
    if (themeOverride) {
      if (isUuid(themeOverride)) {
        themeRow = await db.query.themes.findFirst({
          where: eq(themes.id, themeOverride),
        });
      } else {
        // Exact case-insensitive match first; fall back to substring
        themeRow = await db.query.themes.findFirst({
          where: ilike(themes.name, themeOverride),
          orderBy: (t, { asc }) => asc(t.createdAt),
        });
        if (!themeRow) {
          themeRow = await db.query.themes.findFirst({
            where: ilike(themes.name, `%${themeOverride}%`),
            orderBy: (t, { asc }) => asc(t.createdAt),
          });
        }
      }
      if (!themeRow) {
        return c.json({ error: `Theme "${themeOverride}" not found` }, 404);
      }
    } else if (space.themeId) {
      themeRow = await db.query.themes.findFirst({
        where: eq(themes.id, space.themeId),
      });
    }

    if (themeRow) {
      theme = themeRow.tokens as ThemeTokens;
      // Embed logo as base64 data URL for WeasyPrint (it can't fetch external URLs)
      if (theme.logo && themeRow.logoAssets?.length) {
        try {
          const logoRes = await storage.download(themeRow.logoAssets[0]);
          const logoBuffer = await logoRes.arrayBuffer();
          const ext = themeRow.logoAssets[0].split(".").pop() || "png";
          const mimeTypes: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg" };
          const mime = mimeTypes[ext] || "image/png";
          const b64 = Buffer.from(logoBuffer).toString("base64");
          theme = { ...theme, logo: `data:${mime};base64,${b64}` };
        } catch {}
      }
    }

    // Resolve title-page/toc: explicit query param > theme default > true
    const tocParam = c.req.query("toc");
    const titlePageParam = c.req.query("title-page");
    const showToc = tocParam !== undefined
      ? tocParam !== "false"
      : theme?.print?.defaultToc ?? true;
    const showTitlePage = titlePageParam !== undefined
      ? titlePageParam !== "false"
      : theme?.print?.defaultTitlePage ?? true;

    const printHTML = buildPrintHTML({
      title: doc.title,
      spaceName: space.name,
      html,
      date: new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
      }),
      version: latestVersion.version,
      showTitlePage,
      showToc,
      theme,
    });

    // Send to WeasyPrint service
    try {
      const pdfRes = await fetch(`${env.weasyPrintUrl}/render`, {
        method: "POST",
        headers: { "Content-Type": "text/html" },
        body: printHTML,
      });

      if (!pdfRes.ok) {
        const err = await pdfRes.text();
        return c.json({ error: `PDF rendering failed: ${err}` }, 502);
      }

      const pdfBytes = await pdfRes.arrayBuffer();
      const filename = `${doc.slug}.pdf`;

      return new Response(pdfBytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch (e: any) {
      return c.json(
        { error: `WeasyPrint service unavailable: ${e.message}` },
        503,
      );
    }
  });

  /** Mark all documents in a space as read */
  router.post("/:space/_read-all", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const docs = await db.query.documents.findMany({
      where: eq(documents.spaceId, space.id),
      columns: { id: true },
    });

    const now = new Date();
    for (const doc of docs) {
      await db.insert(documentReads)
        .values({ userId: user.id, documentId: doc.id, readAt: now })
        .onConflictDoUpdate({
          target: [documentReads.userId, documentReads.documentId],
          set: { readAt: now },
        });
    }

    return c.json({ marked: docs.length });
  });

  /** Mark document as read by current user */
  router.post("/:space/:slug/read", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const doc = await db.query.documents.findFirst({
      where: and(eq(documents.spaceId, space.id), eq(documents.slug, c.req.param("slug"))),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const now = new Date();
    await db.insert(documentReads)
      .values({ userId: user.id, documentId: doc.id, readAt: now })
      .onConflictDoUpdate({
        target: [documentReads.userId, documentReads.documentId],
        set: { readAt: now },
      });

    return c.json({ readAt: now.toISOString() });
  });

  /** Toggle watch on a document */
  router.post("/:space/:slug/watch", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const doc = await db.query.documents.findFirst({
      where: and(eq(documents.spaceId, space.id), eq(documents.slug, c.req.param("slug"))),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    // Toggle: if watching, remove; if not, add
    const existing = await db.query.documentWatches.findFirst({
      where: and(eq(documentWatches.userId, user.id), eq(documentWatches.documentId, doc.id)),
    });

    if (existing) {
      await db.delete(documentWatches).where(
        and(eq(documentWatches.userId, user.id), eq(documentWatches.documentId, doc.id)),
      );
      return c.json({ watching: false });
    }

    await db.insert(documentWatches).values({ userId: user.id, documentId: doc.id });
    return c.json({ watching: true });
  });

  /** Check if current user watches a document */
  router.get("/:space/:slug/watch", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ watching: false });

    const doc = await db.query.documents.findFirst({
      where: and(eq(documents.spaceId, space.id), eq(documents.slug, c.req.param("slug"))),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const watch = await db.query.documentWatches.findFirst({
      where: and(eq(documentWatches.userId, user.id), eq(documentWatches.documentId, doc.id)),
    });

    return c.json({ watching: !!watch });
  });

  return router;
}
