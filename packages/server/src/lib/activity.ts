/**
 * Activity log helpers.
 * Called from route handlers after mutations, beside the notify helpers.
 */

import { type Database, spaceEvents } from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";
import { logger } from "../logger.js";

export type EventInput = Omit<
  typeof spaceEvents.$inferInsert,
  "id" | "actorId" | "actorName" | "createdAt"
>;

/**
 * Append events to the activity log. Never throws: the change an event
 * describes has already been made, and a missing log line must not fail it.
 */
export async function recordEvents(
  db: Database,
  actor: AuthUser | null,
  events: EventInput[],
) {
  if (events.length === 0) return;
  try {
    await db.insert(spaceEvents).values(
      events.map((e) => ({
        ...e,
        actorId: actor?.id ?? null,
        actorName: actor?.displayName ?? "System",
      })),
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Failed to record space events");
  }
}

const SNIPPET_LENGTH = 160;

/** Reduce a comment body to one line of plain text for the activity log. */
export function commentSnippet(body: string): string {
  const text = body
    .replace(/```[^\n]*/g, " ")
    // Links and images keep their text; wiki-links keep their label or slug
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|~~|[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > SNIPPET_LENGTH
    ? `${text.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…`
    : text;
}
