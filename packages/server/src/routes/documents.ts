import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { renderMarkdown } from "@sideways/markdown";
import {
  type Database,
  documents,
  documentVersions,
  users,
} from "@sideways/db";
import type { Storage } from "@sideways/storage";

/**
 * Ensure a "system" user exists for unseeded/anonymous operations.
 * Returns the system user's ID.
 */
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

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function createDocumentRoutes(db: Database, storage: Storage) {
  const router = new Hono();

  /** List all documents (metadata only) */
  router.get("/", async (c) => {
    const docs = await db.query.documents.findMany({
      orderBy: desc(documents.updatedAt),
    });
    return c.json(docs);
  });

  /** Get a document by slug (includes latest version content) */
  router.get("/:slug", async (c) => {
    const doc = await db.query.documents.findFirst({
      where: eq(documents.slug, c.req.param("slug")),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });

    return c.json({ ...doc, content: latestVersion?.content ?? "" });
  });

  /** Get a document rendered as HTML */
  router.get("/:slug/render", async (c) => {
    const doc = await db.query.documents.findFirst({
      where: eq(documents.slug, c.req.param("slug")),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    const latestVersion = await db.query.documentVersions.findFirst({
      where: eq(documentVersions.documentId, doc.id),
      orderBy: desc(documentVersions.version),
    });
    if (!latestVersion) return c.json({ error: "No versions" }, 404);

    // Check render cache in SeaweedFS
    const cacheKey = `/rendered/${doc.id}/${latestVersion.contentHash}.html`;
    if (latestVersion.renderedKey) {
      try {
        const cached = await storage.download(latestVersion.renderedKey);
        const html = await cached.text();
        return c.json({ ...doc, html, content: undefined });
      } catch {
        // Cache miss, re-render
      }
    }

    // Render and cache
    const target = c.req.query("target") === "pdf" ? "pdf" : "web";
    const html = await renderMarkdown(latestVersion.content, { target });

    // Store in SeaweedFS (fire and forget for speed)
    storage
      .upload(cacheKey, Buffer.from(html), "text/html")
      .then(() =>
        db
          .update(documentVersions)
          .set({ renderedKey: cacheKey })
          .where(eq(documentVersions.id, latestVersion.id)),
      )
      .catch(() => {});

    return c.json({ ...doc, html, content: undefined });
  });

  /** Create or update a document */
  router.put("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json<{
      title?: string;
      content?: string;
      visibility?: "private" | "shared" | "org" | "public";
      tags?: string[];
      parentId?: string | null;
    }>();

    const systemUserId = await ensureSystemUser(db);
    const content = body.content ?? "";
    const hash = contentHash(content);

    const existing = await db.query.documents.findFirst({
      where: eq(documents.slug, slug),
    });

    if (existing) {
      // Update document metadata
      const [updated] = await db
        .update(documents)
        .set({
          title: body.title ?? existing.title,
          visibility: body.visibility ?? existing.visibility,
          tags: body.tags ?? existing.tags,
          parentId: body.parentId !== undefined ? body.parentId : existing.parentId,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, existing.id))
        .returning();

      // Get current version number
      const latest = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.documentId, existing.id),
        orderBy: desc(documentVersions.version),
      });

      // Only create new version if content changed
      if (!latest || latest.contentHash !== hash) {
        await db.insert(documentVersions).values({
          documentId: existing.id,
          version: (latest?.version ?? 0) + 1,
          title: body.title ?? existing.title,
          content,
          contentHash: hash,
          createdBy: systemUserId,
        });
      }

      return c.json(updated, 200);
    }

    // Create new document
    const [doc] = await db
      .insert(documents)
      .values({
        slug,
        title: body.title ?? slug,
        visibility: body.visibility ?? "private",
        ownerId: systemUserId,
        parentId: body.parentId ?? null,
        tags: body.tags ?? [],
      })
      .returning();

    // Create first version
    await db.insert(documentVersions).values({
      documentId: doc.id,
      version: 1,
      title: doc.title,
      content,
      contentHash: hash,
      createdBy: systemUserId,
    });

    return c.json(doc, 201);
  });

  /** Delete a document */
  router.delete("/:slug", async (c) => {
    const doc = await db.query.documents.findFirst({
      where: eq(documents.slug, c.req.param("slug")),
    });
    if (!doc) return c.json({ error: "Not found" }, 404);

    await db.delete(documents).where(eq(documents.id, doc.id));
    return c.json({ deleted: true });
  });

  /** List versions of a document */
  router.get("/:slug/versions", async (c) => {
    const doc = await db.query.documents.findFirst({
      where: eq(documents.slug, c.req.param("slug")),
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

  return router;
}
