import { Hono } from "hono";
import { eq, desc, and, inArray } from "drizzle-orm";
import { type Database, notifications, documentReads, documents, sections, spaces } from "@sideways/db";
import { docUrl } from "@sideways/types";
import { requireAuth } from "../middleware/auth.js";
import type { AuthUser } from "../middleware/auth.js";

export function createNotificationRoutes(db: Database) {
  const router = new Hono();

  router.use("*", requireAuth());

  /** List notifications for current user */
  router.get("/", async (c) => {
    const user = c.get("user") as AuthUser;
    const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);
    const unreadOnly = c.req.query("unread") === "true";

    // Fetch notifications with read status derived from document_reads
    const allNotifs = await db.query.notifications.findMany({
      where: eq(notifications.userId, user.id),
      orderBy: desc(notifications.createdAt),
      limit: limit,
    });

    // Batch fetch read timestamps for all notified documents
    const docIds = [...new Set(allNotifs.map(n => n.documentId).filter(Boolean))] as string[];
    const reads = docIds.length > 0
      ? await db.query.documentReads.findMany({
          where: eq(documentReads.userId, user.id),
        })
      : [];
    const readMap = new Map(reads.map(r => [r.documentId, r.readAt]));

    // Batch fetch URL parts for each notified doc — joined to (section, space)
    // so the bell can navigate. Live data, not denormalised, so renames/moves
    // don't leave stale links.
    const docUrlParts = docIds.length > 0
      ? await db
          .select({
            id: documents.id,
            path: documents.path,
            sectionSlug: sections.slug,
            spaceSlug: spaces.slug,
          })
          .from(documents)
          .innerJoin(sections, eq(documents.sectionId, sections.id))
          .innerJoin(spaces, eq(documents.spaceId, spaces.id))
          .where(inArray(documents.id, docIds))
      : [];
    const urlMap = new Map(
      docUrlParts.map((d) => [
        d.id,
        docUrl({ spaceSlug: d.spaceSlug, sectionSlug: d.sectionSlug, path: d.path }),
      ]),
    );

    const enriched = allNotifs.map(n => {
      const readAt = n.documentId ? readMap.get(n.documentId) : null;
      const isRead = readAt ? readAt >= n.createdAt : false;
      const url = n.documentId ? urlMap.get(n.documentId) ?? null : null;
      return { ...n, read: isRead, url };
    });

    const filtered = unreadOnly ? enriched.filter(n => !n.read) : enriched;
    const unreadCount = enriched.filter(n => !n.read).length;

    return c.json({ notifications: filtered, unreadCount });
  });

  /** Get unread count only (lightweight) */
  router.get("/count", async (c) => {
    const user = c.get("user") as AuthUser;

    const allNotifs = await db.query.notifications.findMany({
      where: eq(notifications.userId, user.id),
      columns: { id: true, documentId: true, createdAt: true },
      orderBy: desc(notifications.createdAt),
      limit: 100,
    });

    const reads = await db.query.documentReads.findMany({
      where: eq(documentReads.userId, user.id),
    });
    const readMap = new Map(reads.map(r => [r.documentId, r.readAt]));

    const unreadCount = allNotifs.filter(n => {
      const readAt = n.documentId ? readMap.get(n.documentId) : null;
      return !readAt || readAt < n.createdAt;
    }).length;

    return c.json({ unreadCount });
  });

  /** Mark all notifications as read (upsert document_reads for all notified docs) */
  router.post("/read-all", async (c) => {
    const user = c.get("user") as AuthUser;

    const unreadNotifs = await db.query.notifications.findMany({
      where: eq(notifications.userId, user.id),
      columns: { documentId: true },
    });

    const docIds = [...new Set(unreadNotifs.map(n => n.documentId).filter(Boolean))] as string[];
    const now = new Date();

    for (const docId of docIds) {
      await db.insert(documentReads)
        .values({ userId: user.id, documentId: docId, readAt: now })
        .onConflictDoUpdate({
          target: [documentReads.userId, documentReads.documentId],
          set: { readAt: now },
        });
    }

    return c.json({ marked: docIds.length });
  });

  /** Dismiss a single notification */
  router.delete("/:id", async (c) => {
    const user = c.get("user") as AuthUser;
    const id = c.req.param("id");

    await db.delete(notifications).where(
      and(eq(notifications.id, id), eq(notifications.userId, user.id)),
    );

    return c.json({ deleted: true });
  });

  return router;
}
