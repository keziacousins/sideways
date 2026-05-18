import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import {
  type Database,
  comments,
  documents,
  documentWatches,
  spaces,
} from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { canAccessSpace, canWriteSpace } from "../middleware/visibility.js";
import { createNotification, autoWatch, parseMentions } from "../lib/notify.js";
import { resolveSection, findDocByPath } from "../lib/doc-resolver.js";
import { validatePath } from "../middleware/validate.js";

export function createCommentRoutes(db: Database) {
  const router = new Hono();

  /**
   * Resolve `(space, section, path)` from URL params to a doc with read
   * access checked. Used by the doc-targeting comment routes.
   */
  async function resolveDoc(c: any) {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("space")),
    });
    if (!space) return { error: c.json({ error: "Space not found" }, 404) };

    const user = c.get("user") as AuthUser | null;
    if (!(await canAccessSpace(db, space.id, space.visibility, space.ownerId, user))) {
      return { error: c.json({ error: "Forbidden" }, 403) };
    }

    const section = await resolveSection(db, space.id, c.req.param("section"));
    if (!section) return { error: c.json({ error: "Section not found" }, 404) };

    // Same path validation the doc write routes apply — keeps read and
    // write surfaces consistent and fast-rejects obviously malformed
    // paths (.. segments, leading slashes, invalid chars).
    const path = c.req.param("path");
    const pathErr = validatePath(path);
    if (pathErr) return { error: c.json({ error: pathErr }, 400) };

    const doc = await findDocByPath(db, space.id, section.id, path);
    if (!doc) return { error: c.json({ error: "Document not found" }, 404) };

    return { space, section, doc };
  }

  // ── Comment-by-ID routes (single segment, declared first so the path
  //    catch-all under doc routes doesn't accidentally shadow them) ─────

  /** PUT /:commentId — update body. Must be author. */
  router.put("/:commentId", requireAuth(), async (c) => {
    const user = c.get("user") as AuthUser;
    const commentId = c.req.param("commentId");

    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
    });
    if (!comment) return c.json({ error: "Comment not found" }, 404);
    if (comment.authorId !== user.id) {
      return c.json({ error: "Forbidden" }, 403);
    }

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

  /** POST /:commentId/resolve — toggle resolved status. */
  router.post("/:commentId/resolve", requireAuth(), async (c) => {
    const commentId = c.req.param("commentId");
    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
    });
    if (!comment) return c.json({ error: "Comment not found" }, 404);

    // Resolve requires write access to the doc's space.
    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, comment.documentId),
    });
    if (!doc) return c.json({ error: "Document not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, doc.spaceId),
    });
    if (!space || !(await canWriteSpace(db, space.id, space.ownerId, user))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const [updated] = await db
      .update(comments)
      .set({ resolved: !comment.resolved, updatedAt: new Date() })
      .where(eq(comments.id, commentId))
      .returning();

    return c.json(updated);
  });

  /** DELETE /:commentId — delete. Must be author. */
  router.delete("/:commentId", requireAuth(), async (c) => {
    const user = c.get("user") as AuthUser;
    const commentId = c.req.param("commentId");

    const comment = await db.query.comments.findFirst({
      where: eq(comments.id, commentId),
    });
    if (!comment) return c.json({ error: "Comment not found" }, 404);
    if (comment.authorId !== user.id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const hasReplies = await db.query.comments.findFirst({
      where: eq(comments.parentId, commentId),
    });
    if (hasReplies) {
      return c.json({ error: "Cannot delete a comment that has replies. Resolve it instead." }, 409);
    }

    await db.delete(comments).where(eq(comments.id, commentId));
    return c.json({ deleted: true });
  });

  // ── Doc-targeting comment routes ────────────────────────────────────

  /**
   * GET /:space/:section/:path — list comments on a doc.
   * Query: ?include_resolved=true to include resolved comments.
   */
  router.get("/:space/:section/:path{.+}", async (c) => {
    const result = await resolveDoc(c);
    if ("error" in result) return result.error;
    const { doc } = result;

    const includeResolved = c.req.query("include_resolved") === "true";

    const allComments = await db.query.comments.findMany({
      where: includeResolved
        ? eq(comments.documentId, doc.id)
        : and(eq(comments.documentId, doc.id), eq(comments.resolved, false)),
      orderBy: comments.createdAt,
    });

    const authorIds = [...new Set(allComments.map((c) => c.authorId))];
    const authors = authorIds.length
      ? await db.query.users.findMany({
          where: (u, { inArray }) => inArray(u.id, authorIds),
          columns: { id: true, name: true, email: true },
        })
      : [];
    const authorMap = new Map(authors.map((a) => [a.id, a]));

    return c.json(
      allComments.map((comment) => ({
        ...comment,
        author: authorMap.get(comment.authorId) || null,
      })),
    );
  });

  /**
   * POST /:space/:section/:path — create comment on a doc. Requires auth.
   * Body: { body, anchorText?, anchorSection?, anchorContext?, parentId? }
   */
  router.post("/:space/:section/:path{.+}", requireAuth(), async (c) => {
    const user = c.get("user") as AuthUser;

    const result = await resolveDoc(c);
    if ("error" in result) return result.error;
    const { doc } = result;

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
    const notified = new Set<string>();
    const isAgent = !!user.actorName;
    const displayName = user.displayName;

    (async () => {
      // 1. Reply notification
      if (body.parentId) {
        const parent = await db.query.comments.findFirst({
          where: eq(comments.id, body.parentId),
        });
        if (parent && (isAgent || parent.authorId !== user.id)) {
          notified.add(parent.authorId);
          await createNotification({
            db, type: "reply", userId: parent.authorId,
            documentId: doc.id, commentId: comment.id,
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
              title: `${displayName} mentioned you in a comment`,
              body: body.body.slice(0, 200),
              actorName: displayName,
            });
          }
        }
      }

      // 3. Notify watchers
      const watchers = await db.query.documentWatches.findMany({
        where: eq(documentWatches.documentId, doc.id),
      });
      for (const w of watchers) {
        if ((isAgent || w.userId !== user.id) && !notified.has(w.userId)) {
          await createNotification({
            db, type: "new_comment", userId: w.userId,
            documentId: doc.id, commentId: comment.id,
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

  return router;
}
