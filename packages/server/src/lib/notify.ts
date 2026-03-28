/**
 * Notification generation helpers.
 * Called from route handlers after mutations.
 */

import { eq, and } from "drizzle-orm";
import { type Database, notifications, documentWatches, comments } from "@sideways/db";
import { logger } from "../logger.js";

interface NotifyOpts {
  db: Database;
  type: "reply" | "mention" | "doc_updated" | "new_comment";
  userId: string;       // recipient
  documentId: string;
  commentId?: string;
  spaceSlug: string;
  docSlug: string;
  title: string;
  body?: string;
  actorName?: string;
}

/** Create a notification for a single user */
export async function createNotification(opts: NotifyOpts) {
  try {
    await opts.db.insert(notifications).values({
      userId: opts.userId,
      type: opts.type,
      documentId: opts.documentId,
      commentId: opts.commentId,
      spaceSlug: opts.spaceSlug,
      docSlug: opts.docSlug,
      title: opts.title,
      body: opts.body,
      actorName: opts.actorName,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to create notification");
  }
}

/** Notify all watchers of a document, excluding a specific user (the actor) */
export async function notifyWatchers(
  db: Database,
  documentId: string,
  excludeUserId: string,
  opts: {
    type: "doc_updated" | "new_comment";
    spaceSlug: string;
    docSlug: string;
    title: string;
    body?: string;
    actorName?: string;
    commentId?: string;
  },
) {
  try {
    const watchers = await db.query.documentWatches.findMany({
      where: eq(documentWatches.documentId, documentId),
    });

    const recipients = watchers
      .map(w => w.userId)
      .filter(id => id !== excludeUserId);

    for (const userId of recipients) {
      await createNotification({
        db,
        userId,
        documentId,
        ...opts,
      });
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to notify watchers");
  }
}

/** Auto-watch: add user as watcher if not already watching */
export async function autoWatch(db: Database, userId: string, documentId: string) {
  try {
    await db.insert(documentWatches)
      .values({ userId, documentId })
      .onConflictDoNothing();
  } catch {}
}

/** Parse @mentions from comment body. Returns user names/emails found. */
export function parseMentions(body: string): string[] {
  const mentions: string[] = [];
  // Match @name or @email patterns
  const re = /@([\w.+-]+@[\w.-]+|[\w.-]+)/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}
