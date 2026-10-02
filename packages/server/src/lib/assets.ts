/**
 * Asset lookups shared by the asset routes and the PDF pipeline.
 */

import { and, eq } from "drizzle-orm";
import { type Database, assets } from "@sideways/db";
import type { Storage } from "@sideways/storage";

export type AssetRow = typeof assets.$inferSelect;

export async function findAssetByPath(
  db: Database,
  spaceId: string,
  sectionId: string,
  path: string,
): Promise<AssetRow | null> {
  const asset = await db.query.assets.findFirst({
    where: and(
      eq(assets.spaceId, spaceId),
      eq(assets.sectionId, sectionId),
      eq(assets.path, path),
    ),
  });
  return asset ?? null;
}

/** Raw bytes one PDF export may embed as images, across all of them. */
const INLINE_BUDGET = 30 * 1024 * 1024;

/**
 * Build the `inlineAsset` callback for one PDF export: section-relative asset
 * path in, `data:` URI out.
 *
 * WeasyPrint cannot fetch an asset itself — the asset routes want the
 * reader's token, and its URL fetcher refuses private addresses — so the
 * bytes travel inside the HTML, the way the theme logo does.
 *
 * Resolves to null for a path that is not an image asset, or once the export
 * has spent its budget; the renderer then leaves the image as its alt text.
 * Build one per request: the budget and the cache are scoped to it.
 */
export function createAssetInliner(
  db: Database,
  storage: Storage,
  spaceId: string,
  sectionId: string,
): (path: string) => Promise<string | null> {
  let spent = 0;
  // Keyed by path, holding the promise, so an image used twice is read once
  // even when both lookups start before the first finishes.
  const cache = new Map<string, Promise<string | null>>();

  async function load(path: string): Promise<string | null> {
    const asset = await findAssetByPath(db, spaceId, sectionId, path);
    if (!asset || !asset.mimeType.startsWith("image/")) return null;
    if (spent + asset.size > INLINE_BUDGET) return null;
    spent += asset.size;

    try {
      const res = await storage.download(asset.storageKey);
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return `data:${asset.mimeType};base64,${b64}`;
    } catch {
      return null;
    }
  }

  return (path) => {
    let pending = cache.get(path);
    if (!pending) {
      pending = load(path);
      cache.set(path, pending);
    }
    return pending;
  };
}
