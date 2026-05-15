/**
 * Helpers for the path-as-URL doc model.
 *
 * - `resolveSection(spaceId, sectionSlug)` looks up a section.
 * - `resolveDocByUrlPath(spaceId, sectionId, urlPath)` finds the doc that a
 *   URL path points to, applying the `index.md` directory-collapse rule
 *   (URL `architecture` may resolve to either `architecture/index.md` or
 *   `architecture.md`; the directory form wins when both exist).
 * - `enrichDoc(doc, sectionSlug, spaceSlug)` adds the canonical `url` field.
 * - `bustWikiLinkRenderCache(spaceId)` clears the rendered HTML cache for
 *   every doc in a space; call after structural changes (create, rename,
 *   move, delete) since wikilink resolution depends on the doc list.
 */

import { eq, and, sql } from "drizzle-orm";
import { type Database, documents, sections } from "@sideways/db";
import { docUrl } from "@sideways/types";

export type DocRow = typeof documents.$inferSelect;

export async function resolveSection(
  db: Database,
  spaceId: string,
  sectionSlug: string,
) {
  return db.query.sections.findFirst({
    where: and(eq(sections.spaceId, spaceId), eq(sections.slug, sectionSlug)),
  });
}

/**
 * Resolve a URL-style path (the part after `/s/<space>/<section>/`) to the
 * stored document. Empty string → section's `index.md`. Otherwise tries
 * `<urlPath>/index.md` first (directory form) then `<urlPath>.md`.
 */
export async function resolveDocByUrlPath(
  db: Database,
  spaceId: string,
  sectionId: string,
  urlPath: string,
): Promise<DocRow | null> {
  const candidates =
    urlPath === ""
      ? ["index.md"]
      : [`${urlPath}/index.md`, `${urlPath}.md`];

  for (const path of candidates) {
    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.spaceId, spaceId),
        eq(documents.sectionId, sectionId),
        eq(documents.path, path),
      ),
    });
    if (doc) return doc;
  }
  return null;
}

/**
 * Look up a doc by its raw stored path (with `.md` extension). Used by
 * action routes (`_render`, `_pdf`, etc.) where the path arrives literally
 * rather than collapsed.
 */
export async function findDocByPath(
  db: Database,
  spaceId: string,
  sectionId: string,
  path: string,
): Promise<DocRow | null> {
  const doc = await db.query.documents.findFirst({
    where: and(
      eq(documents.spaceId, spaceId),
      eq(documents.sectionId, sectionId),
      eq(documents.path, path),
    ),
  });
  return doc ?? null;
}

/**
 * Add `sectionSlug` and a canonical `url` field to a doc record. Use on
 * any response that returns docs to keep URL construction server-side.
 */
export function enrichDoc<T extends { path: string }>(
  doc: T,
  sectionSlug: string,
  spaceSlug: string,
): T & { sectionSlug: string; url: string } {
  return {
    ...doc,
    sectionSlug,
    url: docUrl({ spaceSlug, sectionSlug, path: doc.path }),
  };
}

/**
 * Clear cached rendered HTML for every doc in a space. Wikilink resolution
 * depends on the doc list, so any structural change (create/rename/move/
 * delete) can change rendered output for unrelated docs in the same space.
 * Cache is rebuilt lazily on next render.
 */
export async function bustWikiLinkRenderCache(
  db: Database,
  spaceId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE document_versions
    SET rendered_key = NULL
    WHERE rendered_key IS NOT NULL
      AND document_id IN (
        SELECT id FROM documents WHERE space_id = ${spaceId}
      )
  `);
}

/**
 * Convert a stored path (e.g. "architecture/overview.md") into the URL-path
 * form (e.g. "architecture/overview") used by action routes' `:path{.+}`
 * parameter. Strips `.md`; collapses `<x>/index.md` to `<x>`; collapses
 * the section root `index.md` to empty string.
 */
export function pathToUrlForm(storedPath: string): string {
  return storedPath.replace(/\.md$/, "").replace(/(^|\/)index$/, "");
}
