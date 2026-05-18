import { Hono } from "hono";
import { eq, desc, and, sql, ilike } from "drizzle-orm";
import { createHash } from "node:crypto";
import { renderMarkdown, RENDERER_VERSION } from "@sideways/markdown";
import {
  type Database,
  documents,
  documentVersions,
  documentReads,
  documentWatches,
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
import { validateTitle, validatePath, validateTags, validateContent } from "../middleware/validate.js";
import { notifyWatchers, notifySpaceWatchers } from "../lib/notify.js";
import { loadWikiLinkContext } from "../lib/wikilinks-context.js";
import {
  resolveSection,
  findDocByPath,
  enrichDoc,
  bustWikiLinkRenderCache,
} from "../lib/doc-resolver.js";

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

/**
 * Resolve a section slug to its id within a space. Falls back to the
 * space's `default` section if no slug is provided. Returns null if the
 * named section doesn't exist (caller decides whether to error or fall
 * back).
 */
async function resolveSectionId(
  db: Database,
  spaceId: string,
  sectionSlug: string | undefined,
): Promise<string | null> {
  const slug = sectionSlug ?? "default";
  const section = await db.query.sections.findFirst({
    where: and(eq(sections.spaceId, spaceId), eq(sections.slug, slug)),
  });
  return section?.id ?? null;
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

  /**
   * Resolve `(spaceSlug, sectionSlug, path)` from URL params to the doc
   * record + section + space, with read-access check. Centralised so every
   * doc-targeting route does the same thing.
   */
  async function resolveDoc(c: any) {
    const spaceResult = await resolveSpace(c, c.req.param("space"));
    if ("error" in spaceResult) return { error: spaceResult.error };
    const { space } = spaceResult;

    const sectionSlug = c.req.param("section");
    const section = await resolveSection(db, space.id, sectionSlug);
    if (!section) return { error: c.json({ error: "Section not found" }, 404) };

    // Reject malformed paths up front — same rules write routes already
    // enforce. The DB lookup is parameterised so this isn't a SQLi
    // mitigation, just a consistency / fast-reject guard.
    const path = c.req.param("path");
    const pathErr = validatePath(path);
    if (pathErr) return { error: c.json({ error: pathErr }, 400) };

    const doc = await findDocByPath(db, space.id, section.id, path);
    if (!doc) return { error: c.json({ error: "Not found" }, 404) };

    return { space, section, doc };
  }

  // ── Space-level (no doc target) ─────────────────────────────────────

  /** List all documents, optionally filtered by space */
  router.get("/", async (c) => {
    const spaceSlug = c.req.query("space");

    if (spaceSlug) {
      const result = await resolveSpace(c, spaceSlug);
      if ("error" in result) return result.error;
      const { space } = result;

      const rows = await db
        .select({
          id: documents.id,
          spaceId: documents.spaceId,
          sectionId: documents.sectionId,
          parentId: documents.parentId,
          path: documents.path,
          title: documents.title,
          position: documents.position,
          tags: documents.tags,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt,
          sectionSlug: sections.slug,
        })
        .from(documents)
        .innerJoin(sections, eq(documents.sectionId, sections.id))
        .where(eq(documents.spaceId, space.id))
        .orderBy(documents.position, documents.title);

      const docs = rows.map((r) => enrichDoc(r, r.sectionSlug, space.slug));

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

  /** Sync metadata for all docs in a space */
  router.get("/:space/_sync", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const sectionFilter = c.req.query("section");
    let sectionId: string | null = null;
    if (sectionFilter) {
      const section = await resolveSection(db, space.id, sectionFilter);
      if (!section) return c.json([]);
      sectionId = section.id;
    }

    const whereClause = sectionId
      ? and(eq(documents.spaceId, space.id), eq(documents.sectionId, sectionId))
      : eq(documents.spaceId, space.id);

    const rows = await db
      .select({
        id: documents.id,
        path: documents.path,
        title: documents.title,
        sectionSlug: sections.slug,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .innerJoin(sections, eq(documents.sectionId, sections.id))
      .where(whereClause)
      .orderBy(documents.position, documents.title);

    const syncInfo = await Promise.all(
      rows.map(async (doc) => {
        const latest = await db.query.documentVersions.findFirst({
          where: eq(documentVersions.documentId, doc.id),
          orderBy: desc(documentVersions.version),
          columns: { version: true, contentHash: true },
        });
        return {
          ...enrichDoc(doc, doc.sectionSlug, space.slug),
          version: latest?.version ?? 0,
          contentHash: latest?.contentHash ?? "",
          updatedAt: doc.updatedAt.toISOString(),
        };
      }),
    );

    return c.json(syncInfo);
  });

  /** Comment counts per document in a space (keyed by section + path) */
  router.get("/:space/_comment-counts", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const rows = await db.execute(sql`
      SELECT s.slug as "sectionSlug", d.path, COUNT(c.id)::int as count
      FROM documents d
      JOIN sections s ON d.section_id = s.id
      LEFT JOIN comments c ON c.document_id = d.id AND c.resolved = false
      WHERE d.space_id = ${space.id}
      GROUP BY s.slug, d.path
      HAVING COUNT(c.id) > 0
    `);

    return c.json(rows);
  });

  /** Autocomplete: title/path search within a space */
  router.get("/:space/_autocomplete", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const q = (c.req.query("q") || "").toLowerCase();
    const rows = await db
      .select({
        path: documents.path,
        title: documents.title,
        sectionSlug: sections.slug,
      })
      .from(documents)
      .innerJoin(sections, eq(documents.sectionId, sections.id))
      .where(eq(documents.spaceId, space.id))
      .orderBy(documents.title);

    const filtered = q
      ? rows.filter(d => d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q))
      : rows;

    return c.json(
      filtered.slice(0, 15).map((d) => enrichDoc(d, d.sectionSlug, space.slug)),
    );
  });

  /**
   * POST /:space/_reorder — bulk reorder documents.
   * Body: [{ sectionSlug, path, position }]
   */
  router.post("/:space/_reorder", async (c) => {
    const result = await resolveSpace(c, c.req.param("space"));
    if ("error" in result) return result.error;
    const { space } = result;

    const user = c.get("user") as AuthUser | null;
    const canWrite = await canWriteSpace(db, space.id, space.ownerId, user);
    if (!canWrite) return c.json({ error: "Forbidden" }, 403);

    const items = await c.req.json<{ sectionSlug: string; path: string; position: number }[]>();

    for (const item of items) {
      const section = await resolveSection(db, space.id, item.sectionSlug);
      if (!section) continue;
      await db
        .update(documents)
        .set({ position: item.position, updatedAt: new Date() })
        .where(
          and(
            eq(documents.spaceId, space.id),
            eq(documents.sectionId, section.id),
            eq(documents.path, item.path),
          ),
        );
    }

    return c.json({ reordered: items.length });
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

  // ── Doc-level: action routes (declared before CRUD so the literal
  //    `_<action>` segment beats the CRUD path catch-all) ──────────────

  /** Preview: render arbitrary markdown without saving */
  router.post("/:space/:section/_render/:path{.+}", async (c) => {
    const spaceResult = await resolveSpace(c, c.req.param("space"));
    if ("error" in spaceResult) return spaceResult.error;
    const { space } = spaceResult;

    const sectionSlug = c.req.param("section");
    const section = await resolveSection(db, space.id, sectionSlug);
    if (!section) return c.json({ error: "Section not found" }, 404);

    const path = c.req.param("path");
    const body = await c.req.json<{ content: string }>();
    const target = c.req.query("target") === "pdf" ? "pdf" : "web";

    const wikiLinks = await loadWikiLinkContext(db, space.id, space.slug, {
      sectionSlug,
      path,
    });

    const html = await renderMarkdown(body.content || "", { target, wikiLinks });
    return c.json({ html });
  });

  /** Get a document rendered as HTML */
  router.get("/:space/:section/_render/:path{.+}", async (c) => {
    const resolved = await resolveDoc(c);
    if ("error" in resolved) return resolved.error;
    const { space, section, doc } = resolved;

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });
    if (!latestVersion) return c.json({ error: "No versions" }, 404);

    const allVersions = await db.query.documentVersions.findMany({
      where: eq(documentVersions.documentId, doc.id),
      columns: { id: true },
    });

    const versionInfo = {
      version: latestVersion.version,
      versionCount: allVersions.length,
      versionDate: latestVersion.createdAt,
    };

    const cacheKey = `/rendered/${doc.id}/${RENDERER_VERSION}-${latestVersion.contentHash}.html`;
    if (latestVersion.renderedKey === cacheKey) {
      try {
        const cached = await storage.download(latestVersion.renderedKey);
        const html = await cached.text();
        return c.json({
          ...enrichDoc(doc, section.slug, space.slug),
          ...versionInfo,
          html,
          content: undefined,
        });
      } catch {
        // Cache miss, re-render
      }
    }

    const target = c.req.query("target") === "pdf" ? "pdf" : "web";
    const wikiLinks = await loadWikiLinkContext(db, space.id, space.slug, {
      sectionSlug: section.slug,
      path: doc.path,
    });
    const html = await renderMarkdown(latestVersion.content, { target, wikiLinks });

    storage
      .upload(cacheKey, Buffer.from(html), "text/html")
      .then(() =>
        db
          .update(documentVersions)
          .set({ renderedKey: cacheKey })
          .where(eq(documentVersions.id, latestVersion.id)),
      )
      .catch(() => {});

    return c.json({
      ...enrichDoc(doc, section.slug, space.slug),
      ...versionInfo,
      html,
      content: undefined,
    });
  });

  /** List versions */
  router.get("/:space/:section/_versions/:path{.+}", async (c) => {
    const resolved = await resolveDoc(c);
    if ("error" in resolved) return resolved.error;
    const { doc } = resolved;

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

  /** Duplicate a document */
  router.post("/:space/:section/_duplicate/:path{.+}", async (c) => {
    const resolved = await resolveDoc(c);
    if ("error" in resolved) return resolved.error;
    const { space, section, doc } = resolved;

    type DuplicateBody = {
      targetSpace?: string;
      targetSection?: string;
      targetPath?: string;
    };
    const body: DuplicateBody = await c.req.json<DuplicateBody>().catch(() => ({}));

    const userId = await getUserId(c, db);

    // Determine target space
    let targetSpace = space;
    if (body.targetSpace && body.targetSpace !== space.slug) {
      const ts = await db.query.spaces.findFirst({
        where: eq(spaces.slug, body.targetSpace),
      });
      if (!ts) return c.json({ error: "Target space not found" }, 404);

      const user = c.get("user") as AuthUser | null;
      if (!await canWriteSpace(db, ts.id, ts.ownerId, user)) {
        return c.json({ error: "No write access to target space" }, 403);
      }
      targetSpace = ts;
    }

    // Determine target section
    let targetSectionId =
      targetSpace.id === space.id
        ? section.id
        : (body.targetSection
            ? (await resolveSectionId(db, targetSpace.id, body.targetSection))
            : null) ?? (await resolveSectionId(db, targetSpace.id, undefined));
    if (body.targetSection && targetSpace.id === space.id) {
      const s = await resolveSection(db, targetSpace.id, body.targetSection);
      if (s) targetSectionId = s.id;
    }
    if (!targetSectionId) {
      return c.json({ error: "Target space is missing its default section (data error)" }, 500);
    }

    // Determine target path: use targetPath if given, else "<path-without-ext>-copy.md"
    let targetPath = body.targetPath;
    if (!targetPath) {
      const stem = doc.path.replace(/\.md$/, "");
      targetPath = `${stem}-copy.md`;
    }
    const pathErr = validatePath(targetPath);
    if (pathErr) return c.json({ error: pathErr }, 400);

    // Disambiguate against existing
    let attempt = 0;
    let candidate = targetPath;
    while (true) {
      const existing = await db.query.documents.findFirst({
        where: and(
          eq(documents.spaceId, targetSpace.id),
          eq(documents.sectionId, targetSectionId),
          eq(documents.path, candidate),
        ),
      });
      if (!existing) break;
      attempt++;
      if (attempt > 20) return c.json({ error: "Could not find unique path" }, 409);
      const stem = targetPath.replace(/\.md$/, "");
      candidate = `${stem}-${attempt}.md`;
    }
    targetPath = candidate;

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });
    const content = latestVersion?.content || "";

    const [newDoc] = await db
      .insert(documents)
      .values({
        spaceId: targetSpace.id,
        path: targetPath,
        sectionId: targetSectionId,
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

    await bustWikiLinkRenderCache(db, targetSpace.id);

    const targetSection = await db.query.sections.findFirst({
      where: eq(sections.id, targetSectionId),
      columns: { slug: true },
    });
    return c.json(
      enrichDoc(newDoc, targetSection?.slug ?? "default", targetSpace.slug),
      201,
    );
  });

  /** Mark document as read by current user */
  router.post("/:space/:section/_read/:path{.+}", async (c) => {
    const resolved = await resolveDoc(c);
    if ("error" in resolved) return resolved.error;
    const { doc } = resolved;

    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

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
  router.post("/:space/:section/_watch/:path{.+}", async (c) => {
    const resolved = await resolveDoc(c);
    if ("error" in resolved) return resolved.error;
    const { doc } = resolved;

    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

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
  router.get("/:space/:section/_watch/:path{.+}", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ watching: false });

    const resolved = await resolveDoc(c);
    if ("error" in resolved) return resolved.error;
    const { doc } = resolved;

    const watch = await db.query.documentWatches.findFirst({
      where: and(eq(documentWatches.userId, user.id), eq(documentWatches.documentId, doc.id)),
    });

    return c.json({ watching: !!watch });
  });

  /** Export a document as PDF */
  router.get("/:space/:section/_pdf/:path{.+}", async (c) => {
    const resolved = await resolveDoc(c);
    if ("error" in resolved) return resolved.error;
    const { space, section, doc } = resolved;

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });
    if (!latestVersion) return c.json({ error: "No versions" }, 404);

    const wikiLinks = await loadWikiLinkContext(db, space.id, space.slug, {
      sectionSlug: section.slug,
      path: doc.path,
    });
    const html = await renderMarkdown(latestVersion.content, { target: "pdf", wikiLinks });

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
      // Filename: basename of path with .pdf extension
      const baseName = doc.path.replace(/\.md$/, "").split("/").pop() || "document";
      const filename = `${baseName}.pdf`;

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

  // ── Doc-level: CRUD ────────────────────────────────────────────────

  /** Get a document by space/section/path */
  router.get("/:space/:section/:path{.+}", async (c) => {
    const resolved = await resolveDoc(c);
    if ("error" in resolved) return resolved.error;
    const { space, section, doc } = resolved;

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });

    return c.json({
      ...enrichDoc(doc, section.slug, space.slug),
      content: latestVersion?.content ?? "",
    });
  });

  /** Create or update a document at a given path */
  router.put("/:space/:section/:path{.+}", async (c) => {
    const spaceSlug = c.req.param("space");
    const sectionSlug = c.req.param("section");
    const path = c.req.param("path");

    const body = await c.req.json<{
      title?: string;
      content?: string;
      tags?: string[];
      position?: number;
      parentPath?: string;
      updatedAt?: string;
    }>();

    const pathErr = validatePath(path);
    if (pathErr) return c.json({ error: pathErr }, 400);
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

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, spaceSlug),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!(await canWriteSpace(db, space.id, space.ownerId, user))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const section = await resolveSection(db, space.id, sectionSlug);
    if (!section) return c.json({ error: "Section not found" }, 404);

    let parentId: string | null | undefined = undefined;
    if (body.parentPath !== undefined) {
      if (body.parentPath === "") {
        parentId = null;
      } else {
        const parent = await findDocByPath(db, space.id, section.id, body.parentPath);
        if (parent) parentId = parent.id;
      }
    }

    const existing = await findDocByPath(db, space.id, section.id, path);

    const derivedTitle = body.title || (hasContent ? extractTitle(content) : null);

    if (existing) {
      const updates: Record<string, any> = {
        title: derivedTitle ?? existing.title,
        tags: body.tags ?? existing.tags,
        position: body.position ?? existing.position,
        updatedAt: body.updatedAt ? new Date(body.updatedAt) : new Date(),
      };
      if (parentId !== undefined) updates.parentId = parentId;

      const [updated] = await db
        .update(documents)
        .set(updates)
        .where(eq(documents.id, existing.id))
        .returning();

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

          const actor = c.get("user") as AuthUser | null;
          const excludeId = actor?.actorName ? "" : userId;
          notifyWatchers(db, existing.id, excludeId, {
            type: "doc_updated",
            title: `${updated.title} was updated`,
            actorName: actor?.displayName,
          }).then(async () => {
            const docWatchers = await db.query.documentWatches.findMany({
              where: eq(documentWatches.documentId, existing.id),
            });
            await notifySpaceWatchers(db, space.id, existing.id, excludeId, docWatchers.map(w => w.userId), {
              type: "doc_updated",
              title: `${updated.title} was updated`,
              actorName: actor?.displayName,
            });
          }).catch(() => {});
        }
      }

      updateSearchIndex(db, existing.id, updated.title, updated.tags || [], content).catch(() => {});

      return c.json(enrichDoc(updated, section.slug, space.slug), 200);
    }

    const [doc] = await db
      .insert(documents)
      .values({
        spaceId: space.id,
        sectionId: section.id,
        path,
        title: derivedTitle || path.replace(/\.md$/, "").split("/").pop() || path,
        tags: body.tags ?? [],
        position: body.position ?? 0,
        ...(parentId ? { parentId } : {}),
      })
      .returning();

    await db.insert(documentVersions).values({
      documentId: doc.id,
      version: 1,
      title: doc.title,
      content,
      contentHash: hash || contentHash(content),
      createdBy: userId,
    });

    updateSearchIndex(db, doc.id, doc.title, doc.tags || [], content).catch(() => {});
    await bustWikiLinkRenderCache(db, space.id);

    const actor = c.get("user") as AuthUser | null;
    const excludeId = actor?.actorName ? "" : userId;
    notifySpaceWatchers(db, space.id, doc.id, excludeId, [], {
      type: "doc_created",
      title: `${doc.title} was created`,
      actorName: actor?.displayName,
    }).catch(() => {});

    return c.json(enrichDoc(doc, section.slug, space.slug), 201);
  });

  /** Delete a document */
  router.delete("/:space/:section/:path{.+}", async (c) => {
    const spaceResult = await resolveSpace(c, c.req.param("space"));
    if ("error" in spaceResult) return spaceResult.error;
    const { space } = spaceResult;

    const user = c.get("user") as AuthUser | null;
    const canWrite = await canWriteSpace(db, space.id, space.ownerId, user);
    if (!canWrite) return c.json({ error: "Forbidden" }, 403);

    const section = await resolveSection(db, space.id, c.req.param("section"));
    if (!section) return c.json({ error: "Section not found" }, 404);

    const doc = await findDocByPath(db, space.id, section.id, c.req.param("path"));
    if (!doc) return c.json({ error: "Not found" }, 404);

    await db.delete(documents).where(eq(documents.id, doc.id));
    await bustWikiLinkRenderCache(db, space.id);
    return c.json({ deleted: true });
  });

  /**
   * PATCH /:space/:section/:path — partial update (rename/move/reorder).
   * Body fields:
   *   title, tags, position
   *   targetSpace?, targetSection?, targetPath?, parentPath?
   * Never touches content/versions.
   */
  router.patch("/:space/:section/:path{.+}", async (c) => {
    const spaceResult = await resolveSpace(c, c.req.param("space"));
    if ("error" in spaceResult) return spaceResult.error;
    const { space } = spaceResult;

    const user = c.get("user") as AuthUser | null;
    const canWrite = await canWriteSpace(db, space.id, space.ownerId, user);
    if (!canWrite) return c.json({ error: "Forbidden" }, 403);

    const section = await resolveSection(db, space.id, c.req.param("section"));
    if (!section) return c.json({ error: "Section not found" }, 404);

    const doc = await findDocByPath(db, space.id, section.id, c.req.param("path"));
    if (!doc) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{
      title?: string;
      tags?: string[];
      position?: number;
      targetSpace?: string;
      targetSection?: string;
      targetPath?: string;
      parentPath?: string | null;
    }>();

    const updates: Record<string, any> = {};
    let structuralChange = false;

    if (body.title !== undefined) updates.title = body.title;
    if (body.tags !== undefined) updates.tags = body.tags;
    if (body.position !== undefined) updates.position = body.position;

    if (body.parentPath !== undefined) {
      if (body.parentPath === null) {
        updates.parentId = null;
      } else {
        const parent = await findDocByPath(db, space.id, section.id, body.parentPath);
        if (!parent) return c.json({ error: "Parent document not found" }, 404);
        updates.parentId = parent.id;
      }
    }

    // Cross-space move
    let targetSpace = space;
    if (body.targetSpace && body.targetSpace !== space.slug) {
      const ts = await db.query.spaces.findFirst({
        where: eq(spaces.slug, body.targetSpace),
      });
      if (!ts) return c.json({ error: "Target space not found" }, 404);

      if (!(await canWriteSpace(db, ts.id, ts.ownerId, user))) {
        return c.json({ error: "Forbidden: no write access to target space" }, 403);
      }
      targetSpace = ts;
      updates.spaceId = ts.id;
      structuralChange = true;
    }

    // Move to different section
    let targetSectionId = section.id;
    if (body.targetSection !== undefined) {
      const targetSec = await resolveSection(db, targetSpace.id, body.targetSection);
      if (!targetSec) return c.json({ error: "Target section not found" }, 404);
      targetSectionId = targetSec.id;
      updates.sectionId = targetSec.id;
      structuralChange = true;
    } else if (targetSpace.id !== space.id) {
      // Cross-space move with no target section: land in default
      const defaultSecId = await resolveSectionId(db, targetSpace.id, undefined);
      if (!defaultSecId) {
        return c.json({ error: "Target space is missing its default section" }, 500);
      }
      targetSectionId = defaultSecId;
      updates.sectionId = defaultSecId;
    }

    // Rename/move within section (path change)
    let finalPath = doc.path;
    if (body.targetPath && body.targetPath !== doc.path) {
      const pathErr = validatePath(body.targetPath);
      if (pathErr) return c.json({ error: pathErr }, 400);

      const collision = await findDocByPath(
        db,
        targetSpace.id,
        targetSectionId,
        body.targetPath,
      );
      if (collision && collision.id !== doc.id) {
        return c.json({ error: `Path "${body.targetPath}" already exists in target` }, 409);
      }
      updates.path = body.targetPath;
      finalPath = body.targetPath;
      structuralChange = true;
    }

    if (Object.keys(updates).length === 0) {
      const sectionRow = await db.query.sections.findFirst({
        where: eq(sections.id, doc.sectionId),
        columns: { slug: true },
      });
      return c.json(enrichDoc(doc, sectionRow?.slug ?? section.slug, space.slug), 200);
    }

    updates.updatedAt = new Date();
    const [updated] = await db
      .update(documents)
      .set(updates)
      .where(eq(documents.id, doc.id))
      .returning();

    if (body.title !== undefined || body.tags !== undefined) {
      const latestVersion = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.documentId, doc.id),
        orderBy: desc(documentVersions.version),
        columns: { content: true },
      });
      updateSearchIndex(db, doc.id, updated.title, updated.tags || [], latestVersion?.content || "").catch(() => {});
    }

    if (structuralChange) {
      await bustWikiLinkRenderCache(db, space.id);
      if (targetSpace.id !== space.id) {
        await bustWikiLinkRenderCache(db, targetSpace.id);
      }
    }

    // Resolve final section slug for response
    const finalSection = await db.query.sections.findFirst({
      where: eq(sections.id, targetSectionId),
      columns: { slug: true },
    });
    return c.json(
      enrichDoc({ ...updated, path: finalPath }, finalSection?.slug ?? section.slug, targetSpace.slug),
    );
  });

  return router;
}
