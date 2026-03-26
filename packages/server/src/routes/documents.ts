import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import { renderMarkdown } from "@sideways/markdown";
import {
  type Database,
  documents,
  documentVersions,
  spaces,
  users,
} from "@sideways/db";
import type { Storage } from "@sideways/storage";
import type { AuthUser } from "../middleware/auth.js";
import { canAccessSpace, canWriteSpace } from "../middleware/visibility.js";

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
      const space = await db.query.spaces.findFirst({
        where: eq(spaces.slug, spaceSlug),
      });
      if (!space) return c.json({ error: "Space not found" }, 404);

      const docs = await db.query.documents.findMany({
        where: eq(documents.spaceId, space.id),
        orderBy: [documents.position, documents.title],
      });
      return c.json(docs);
    }

    const docs = await db.query.documents.findMany({
      orderBy: [documents.position, documents.title],
    });
    return c.json(docs);
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

    const target = c.req.query("target") === "pdf" ? "pdf" : "web";
    const html = await renderMarkdown(latestVersion.content, { target });

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
    }>();

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

    const existing = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, slug),
      ),
    });

    if (existing) {
      const [updated] = await db
        .update(documents)
        .set({
          title: body.title ?? existing.title,
          tags: body.tags ?? existing.tags,
          position: body.position ?? existing.position,
          updatedAt: new Date(),
        })
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
        }
      }

      return c.json(updated, 200);
    }

    const [doc] = await db
      .insert(documents)
      .values({
        spaceId: space.id,
        slug,
        title: body.title ?? slug,
        tags: body.tags ?? [],
        position: body.position ?? 0,
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

  return router;
}
