import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import {
  type Database,
  comments,
  documents,
  spaces,
  users,
} from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { canAccessSpace } from "../middleware/visibility.js";

export function createCommentRoutes(db: Database) {
  const router = new Hono();

  /**
   * GET /api/comments/:space/:slug
   * List comments on a document. Includes author name/email.
   * Query: ?include_resolved=true to include resolved comments.
   */
  router.get("/:space/:slug", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("space")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!(await canAccessSpace(db, space.id, space.visibility, space.ownerId, user))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Document not found" }, 404);

    const includeResolved = c.req.query("include_resolved") === "true";

    const allComments = await db.query.comments.findMany({
      where: includeResolved
        ? eq(comments.documentId, doc.id)
        : and(eq(comments.documentId, doc.id), eq(comments.resolved, false)),
      orderBy: comments.createdAt,
    });

    // Fetch author info
    const authorIds = [...new Set(allComments.map((c) => c.authorId))];
    const authors = authorIds.length
      ? await db.query.users.findMany({
          where: (u, { inArray }) => inArray(u.id, authorIds),
          columns: { id: true, name: true, email: true },
        })
      : [];
    const authorMap = new Map(authors.map((a) => [a.id, a]));

    const result = allComments.map((comment) => ({
      ...comment,
      author: authorMap.get(comment.authorId) || null,
    }));

    return c.json(result);
  });

  /**
   * POST /api/comments/:space/:slug
   * Create a comment. Requires auth.
   * Body: { body, anchorText?, parentId? }
   */
  router.post("/:space/:slug", requireAuth(), async (c) => {
    const user = c.get("user") as AuthUser;

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("space")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, space.id),
        eq(documents.slug, c.req.param("slug")),
      ),
    });
    if (!doc) return c.json({ error: "Document not found" }, 404);

    const body = await c.req.json<{
      body: string;
      anchorText?: string;
      anchorSection?: string;
      anchorContext?: string;
      parentId?: string;
    }>();

    const [comment] = await db
      .insert(comments)
      .values({
        documentId: doc.id,
        authorId: user.id,
        body: body.body,
        anchorText: body.anchorText ?? null,
        anchorSection: body.anchorSection ?? null,
        anchorContext: body.anchorContext ?? null,
        parentId: body.parentId ?? null,
      })
      .returning();

    return c.json(comment, 201);
  });

  /**
   * PUT /api/comments/:space/:slug/:commentId
   * Update a comment (body only). Must be author.
   */
  router.put("/:space/:slug/:commentId", requireAuth(), async (c) => {
    const user = c.get("user") as AuthUser;
    const commentId = c.req.param("commentId");

    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
    });
    if (!comment) return c.json({ error: "Comment not found" }, 404);
    if (comment.authorId !== user.id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json<{ body: string }>();

    const [updated] = await db
      .update(comments)
      .set({ body: body.body, updatedAt: new Date() })
      .where(eq(comments.id, commentId))
      .returning();

    return c.json(updated);
  });

  /**
   * POST /api/comments/:space/:slug/:commentId/resolve
   * Toggle resolved status. Any authenticated user can resolve.
   */
  router.post("/:space/:slug/:commentId/resolve", requireAuth(), async (c) => {
    const commentId = c.req.param("commentId");

    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
    });
    if (!comment) return c.json({ error: "Comment not found" }, 404);

    const [updated] = await db
      .update(comments)
      .set({ resolved: !comment.resolved, updatedAt: new Date() })
      .where(eq(comments.id, commentId))
      .returning();

    return c.json(updated);
  });

  /**
   * DELETE /api/comments/:space/:slug/:commentId
   * Delete a comment. Must be author.
   */
  router.delete("/:space/:slug/:commentId", requireAuth(), async (c) => {
    const user = c.get("user") as AuthUser;
    const commentId = c.req.param("commentId");

    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
    });
    if (!comment) return c.json({ error: "Comment not found" }, 404);
    if (comment.authorId !== user.id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await db.delete(comments).where(eq(comments.id, commentId));
    return c.json({ deleted: true });
  });

  return router;
}
