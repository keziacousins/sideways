import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { type Database, assets, sections, spaces } from "@sideways/db";
import type { Storage } from "@sideways/storage";
import { assetUrl } from "@sideways/types";
import type { AuthUser } from "../middleware/auth.js";
import { canAccessSpace, canWriteSpace } from "../middleware/visibility.js";
import { validateAssetPath } from "../middleware/validate.js";
import { resolveSection } from "../lib/doc-resolver.js";
import { checkAssetUpload, MAX_ASSET_SIZE } from "../lib/asset-type.js";
import { findAssetByPath, type AssetRow } from "../lib/assets.js";

/**
 * Asset responses are user-uploaded bytes served from our own origin, so a
 * direct visit must not be able to run anything: no scripts, no subresources,
 * and an opaque origin. SVG is why this matters — inside `<img>` it is inert,
 * but opened in its own tab it is a document, and can carry `<script>`.
 */
const INERT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function responseHeaders(asset: AssetRow): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType,
    // Path segments are restricted to [A-Za-z0-9._-], so the name needs no quoting.
    "Content-Disposition": `inline; filename="${asset.path.split("/").pop()}"`,
    ETag: `"${asset.contentHash}"`,
    // Access-controlled and mutable by path: cacheable, but only by the
    // reader's own browser, and revalidated on every use.
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  // Not on PDFs: the browser's built-in viewer does not start inside a
  // sandboxed document, and a PDF has no script context of ours to protect.
  if (asset.mimeType !== "application/pdf") {
    headers["Content-Security-Policy"] = INERT_CSP;
  }
  return headers;
}

/** True if an `If-None-Match` header names this ETag (weak or strong). */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag || t === "*");
}

function present(asset: AssetRow, sectionSlug: string, spaceSlug: string) {
  return {
    path: asset.path,
    sectionSlug,
    mimeType: asset.mimeType,
    size: asset.size,
    contentHash: asset.contentHash,
    updatedAt: asset.updatedAt.toISOString(),
    url: assetUrl({ spaceSlug, sectionSlug, path: asset.path }),
  };
}

// Stops reading at the cap, whether or not the client declared a length.
const uploadLimit = bodyLimit({
  maxSize: MAX_ASSET_SIZE,
  onError: (c) => c.json({ error: "File too large" }, 413),
});

export function createAssetRoutes(db: Database, storage: Storage) {
  const router = new Hono();

  /**
   * Resolve `(space, section)` from the URL and check access. Every route
   * here does the same lookup; only the access level differs.
   */
  async function resolveTarget(c: any, access: "read" | "write") {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("space")),
    });
    if (!space) return { error: c.json({ error: "Space not found" }, 404) };

    const user = c.get("user") as AuthUser | null;
    const allowed =
      access === "write"
        ? await canWriteSpace(db, space.id, space.ownerId, user)
        : await canAccessSpace(db, space.id, space.visibility, space.ownerId, user);
    if (!allowed) return { error: c.json({ error: "Forbidden" }, 403) };

    const section = await resolveSection(db, space.id, c.req.param("section"));
    if (!section) return { error: c.json({ error: "Section not found" }, 404) };

    const path = c.req.param("path");
    const pathErr = validateAssetPath(path);
    if (pathErr) return { error: c.json({ error: pathErr }, 400) };

    return { space, section, path, user };
  }

  /** Delete the stored bytes once no asset row points at them. */
  async function releaseBlob(storageKey: string) {
    const stillUsed = await db.query.assets.findFirst({
      where: eq(assets.storageKey, storageKey),
      columns: { id: true },
    });
    if (stillUsed) return;
    await storage.delete(storageKey).catch(() => {});
  }

  /** List the assets in a space, optionally one section's — sync metadata. */
  router.get("/:space", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("space")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!(await canAccessSpace(db, space.id, space.visibility, space.ownerId, user))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const sectionFilter = c.req.query("section");
    const rows = await db
      .select({ asset: assets, sectionSlug: sections.slug })
      .from(assets)
      .innerJoin(sections, eq(assets.sectionId, sections.id))
      .where(
        sectionFilter
          ? and(eq(assets.spaceId, space.id), eq(sections.slug, sectionFilter))
          : eq(assets.spaceId, space.id),
      )
      .orderBy(sections.slug, assets.path);

    return c.json(rows.map((r) => present(r.asset, r.sectionSlug, space.slug)));
  });

  /** Serve an asset's bytes */
  router.get("/:space/:section/:path{.+}", async (c) => {
    const target = await resolveTarget(c, "read");
    if ("error" in target) return target.error;
    const { space, section, path } = target;

    const asset = await findAssetByPath(db, space.id, section.id, path);
    if (!asset) return c.json({ error: "Not found" }, 404);

    const headers = responseHeaders(asset);
    if (etagMatches(c.req.header("If-None-Match"), headers.ETag)) {
      return new Response(null, { status: 304, headers });
    }

    try {
      const stored = await storage.download(asset.storageKey);
      return new Response(stored.body, {
        headers: { ...headers, "Content-Length": String(asset.size) },
      });
    } catch {
      return c.json({ error: "Asset not found in storage" }, 404);
    }
  });

  /**
   * Upload an asset: the raw file as the request body, created or replaced at
   * the path. The Content-Type header is ignored; the type comes from the
   * extension and has to match the bytes. With `If-None-Match: *` an existing
   * asset holding different bytes is kept, and the upload answers 412.
   */
  router.put("/:space/:section/:path{.+}", uploadLimit, async (c) => {
    const target = await resolveTarget(c, "write");
    if ("error" in target) return target.error;
    const { space, section, path, user } = target;

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const check = checkAssetUpload(path, bytes);
    if ("error" in check) return c.json({ error: check.error }, check.status);

    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = await findAssetByPath(db, space.id, section.id, path);
    if (existing?.contentHash === hash) {
      return c.json(present(existing, section.slug, space.slug), 200);
    }
    // `If-None-Match: *` asks for create-only: the web editor names a dropped
    // file after the original, and must not replace a different file that
    // happens to share the name. The same bytes again are fine — see above.
    if (existing && c.req.header("If-None-Match") === "*") {
      return c.json({ error: "An asset already exists at this path" }, 412);
    }

    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const storageKey = `/assets/${space.id}/${hash}.${extension}`;
    if (!(await storage.exists(storageKey))) {
      await storage.upload(storageKey, Buffer.from(bytes), check.mimeType);
    }

    const values = {
      mimeType: check.mimeType,
      size: bytes.length,
      contentHash: hash,
      storageKey,
      // canWriteSpace has already refused an anonymous caller.
      uploadedBy: user!.id,
    };
    // An upsert rather than insert-or-update on `existing`, so two uploads
    // racing to create the same path both succeed.
    const [asset] = await db
      .insert(assets)
      .values({ spaceId: space.id, sectionId: section.id, path, ...values })
      .onConflictDoUpdate({
        target: [assets.spaceId, assets.sectionId, assets.path],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();

    if (existing && existing.storageKey !== storageKey) {
      await releaseBlob(existing.storageKey);
    }

    return c.json(present(asset, section.slug, space.slug), existing ? 200 : 201);
  });

  /** Delete an asset */
  router.delete("/:space/:section/:path{.+}", async (c) => {
    const target = await resolveTarget(c, "write");
    if ("error" in target) return target.error;
    const { space, section, path } = target;

    const asset = await findAssetByPath(db, space.id, section.id, path);
    if (!asset) return c.json({ error: "Not found" }, 404);

    await db.delete(assets).where(eq(assets.id, asset.id));
    await releaseBlob(asset.storageKey);
    return c.json({ deleted: true });
  });

  return router;
}
