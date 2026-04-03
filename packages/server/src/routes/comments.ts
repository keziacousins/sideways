import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import {
  type Database,
  comments,
  documents,
  documentWatches,
  spaces,
  users,
} from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { canAccessSpace, canWriteSpace } from "../middleware/visibility.js";
import { createNotification, notifyWatchers, autoWatch, parseMentions } from "../lib/notify.js";

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

    if (!body.body || body.body.length > 10_000) {
      return c.json({ error: "Comment body required (max 10,000 characters)" }, 400);
    }

    if (body.parentId) {
      const parent = await db.query.comments.findFirst({
        where: and(eq(comments.id, body.parentId), eq(comments.documentId, doc.id)),
      });
      if (!parent) return c.json({ error: "Parent comment not found" }, 404);
    }

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
        actorName: user.actorName ?? null,
      })
      .returning();

    // Fire notifications (async, don't block response)
    const spaceSlug = c.req.param("space");
    const docSlug = c.req.param("slug");
    const notified = new Set<string>(); // prevent double-notify
    const isAgent = !!user.actorName; // API key with actor name = bot/agent
    const displayName = user.displayName;

    (async () => {
      // 1. Reply notification — agents always notify, even the key owner
      if (body.parentId) {
        const parent = await db.query.comments.findFirst({
          where: eq(comments.id, body.parentId),
        });
        if (parent && (isAgent || parent.authorId !== user.id)) {
          notified.add(parent.authorId);
          await createNotification({
            db, type: "reply", userId: parent.authorId,
            documentId: doc.id, commentId: comment.id,
            spaceSlug, docSlug,
            title: `${displayName} replied to your comment`,
            body: body.body.slice(0, 200),
            actorName: displayName,
          });
        }
      }

      // 2. @mention notifications
      const mentions = parseMentions(body.body);
      if (mentions.length > 0) {
        for (const mention of mentions) {
          const mentioned = await db.query.users.findFirst({
            where: (u, { or, eq: e }) => or(e(u.email, mention), e(u.name, mention)),
          });
          if (mentioned && mentioned.id !== user.id && !notified.has(mentioned.id)) {
            notified.add(mentioned.id);
            await createNotification({
              db, type: "mention", userId: mentioned.id,
              documentId: doc.id, commentId: comment.id,
              spaceSlug, docSlug,
              title: `${displayName} mentioned you in a comment`,
              body: body.body.slice(0, 200),
              actorName: displayName,
            });
          }
        }
      }

      // 3. Notify watchers (excluding commenter unless agent, and already-notified)
      const watchers = await db.query.documentWatches.findMany({
        where: eq(documentWatches.documentId, doc.id),
      });
      for (const w of watchers) {
        if ((isAgent || w.userId !== user.id) && !notified.has(w.userId)) {
          await createNotification({
            db, type: "new_comment", userId: w.userId,
            documentId: doc.id, commentId: comment.id,
            spaceSlug, docSlug,
            title: `${displayName} commented on ${doc.title}`,
            body: body.body.slice(0, 200),
            actorName: displayName,
          });
        }
      }

      // 4. Auto-watch: commenter watches the doc
      await autoWatch(db, user.id, doc.id);
    })().catch(() => {});

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

    // Can only edit if no replies
    const hasReplies = await db.query.comments.findFirst({
      where: eq(comments.parentId, commentId),
    });
    if (hasReplies) {
      return c.json({ error: "Cannot edit a comment that has replies" }, 409);
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
   * Toggle resolved status. Requires write access to the space.
   */
  router.post("/:space/:slug/:commentId/resolve", requireAuth(), async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("space")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!await canWriteSpace(db, space.id, space.ownerId, user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

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

    // Can only delete if no replies
    const hasReplies = await db.query.comments.findFirst({
      where: eq(comments.parentId, commentId),
    });
    if (hasReplies) {
      return c.json({ error: "Cannot delete a comment that has replies. Resolve it instead." }, 409);
    }

    await db.delete(comments).where(eq(comments.id, commentId));
    return c.json({ deleted: true });
  });

  return router;
}
