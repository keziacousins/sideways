import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, users, apiKeys, spaces, sections } from "@sideways/db";
import { createStorage } from "@sideways/storage";
import { createAssetRoutes } from "../routes/assets.js";
import { createSpaceRoutes } from "../routes/spaces.js";
import { authMiddleware } from "../middleware/auth.js";
import { createAssetInliner } from "../lib/assets.js";

/**
 * Integration tests for hosted assets, against real Postgres and SeaweedFS.
 * Same wiring as api.test.ts: Hono's test client, API-key auth.
 */

const db = createDb(process.env.DATABASE_URL!);
const storage = createStorage({
  filerUrl: process.env.SEAWEEDFS_FILER_URL || "http://localhost:8888",
});

const app = new Hono();
app.use("*", authMiddleware(db));
app.route("/api/spaces", createSpaceRoutes(db));
app.route("/api/assets", createAssetRoutes(db, storage));

async function createTestUser(): Promise<Record<string, string>> {
  const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const [user] = await db
    .insert(users)
    .values({
      email: `asset-test-${unique}@sideways.dev`,
      name: "Asset Tester",
      hydraSubject: `kratos-asset-${unique}`,
    })
    .returning();

  const rawKey = `sk-${randomBytes(32).toString("base64url")}`;
  await db.insert(apiKeys).values({
    userId: user.id,
    name: "Test key",
    keyHash: createHash("sha256").update(rawKey).digest("hex"),
    prefix: rawKey.slice(0, 11),
  });

  return { Authorization: `Bearer ${rawKey}` };
}

const text = (s: string) => new TextEncoder().encode(s);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Bytes that sniff as a PNG; `tag` makes each fixture's content distinct. */
function png(tag: string): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...text(tag)]);
}
const PDF = text("%PDF-1.7\nnot really a document\n");
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const SPACE = `assets-${Date.now()}`;
const PRIVATE_SPACE = `assets-private-${Date.now()}`;
const base = `/api/assets/${SPACE}/default`;
let auth: Record<string, string>;

function put(url: string, bytes: Uint8Array, headers: Record<string, string> = auth) {
  // A Uint8Array is a valid body at runtime; its TS type (ArrayBufferLike vs.
  // ArrayBuffer) trips the lib.dom BodyInit constraint.
  return app.request(url, { method: "PUT", body: bytes as unknown as BodyInit, headers });
}

describe("hosted assets", () => {
  beforeAll(async () => {
    auth = await createTestUser();
    for (const [slug, visibility] of [[SPACE, "public"], [PRIVATE_SPACE, "private"]]) {
      const res = await app.request(`/api/spaces/${slug}`, {
        method: "PUT",
        body: JSON.stringify({ name: slug, visibility }),
        headers: { "Content-Type": "application/json", ...auth },
      });
      expect(res.status).toBe(201);
    }
  });

  describe("upload", () => {
    it("stores a new asset and describes it", async () => {
      const bytes = png("first");
      const res = await put(`${base}/guides/img/flow.png`, bytes);
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        path: "guides/img/flow.png",
        sectionSlug: "default",
        mimeType: "image/png",
        size: bytes.length,
        contentHash: sha256(bytes),
        url: `/a/${SPACE}/default/guides/img/flow.png`,
      });
    });

    it("takes the type from the bytes, not from the Content-Type header", async () => {
      const res = await put(`${base}/typed.png`, png("typed"), {
        ...auth,
        "Content-Type": "text/html",
      });
      expect(res.status).toBe(201);
      expect((await res.json()).mimeType).toBe("image/png");
    });

    it("is a no-op when the bytes are unchanged", async () => {
      const bytes = png("first");
      const res = await put(`${base}/guides/img/flow.png`, bytes);
      expect(res.status).toBe(200);
      expect((await res.json()).contentHash).toBe(sha256(bytes));
    });

    it("replaces the bytes at an existing path", async () => {
      const bytes = png("second");
      const res = await put(`${base}/guides/img/flow.png`, bytes);
      expect(res.status).toBe(200);
      expect((await res.json()).contentHash).toBe(sha256(bytes));

      const served = await app.request(`${base}/guides/img/flow.png`);
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
    });

    it("refuses bytes that are not what the extension names", async () => {
      const res = await put(`${base}/disguised.png`, PDF);
      expect(res.status).toBe(415);
      expect((await app.request(`${base}/disguised.png`)).status).toBe(404);
    });

    it("refuses a path with no hosted extension", async () => {
      expect((await put(`${base}/archive.zip`, png("zip"))).status).toBe(400);
      expect((await put(`${base}/notes.md`, png("md"))).status).toBe(400);
    });

    it("refuses an anonymous upload", async () => {
      const res = await put(`${base}/anon.png`, png("anon"), {});
      expect(res.status).toBe(403);
    });

    it("404s for a section that doesn't exist", async () => {
      const res = await put(`/api/assets/${SPACE}/nope/a.png`, png("nope"));
      expect(res.status).toBe(404);
    });
  });

  describe("serving", () => {
    it("serves the bytes with their type and a validator", async () => {
      const bytes = png("second");
      const res = await app.request(`${base}/guides/img/flow.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("ETag")).toBe(`"${sha256(bytes)}"`);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(res.headers.get("Content-Disposition")).toBe('inline; filename="flow.png"');
    });

    it("answers 304 when the reader already has the current bytes", async () => {
      const etag = `"${sha256(png("second"))}"`;
      const fresh = await app.request(`${base}/guides/img/flow.png`, {
        headers: { "If-None-Match": etag },
      });
      expect(fresh.status).toBe(304);
      expect(fresh.headers.get("ETag")).toBe(etag);

      // nginx weakens the validator when it compresses a response.
      const weak = await app.request(`${base}/guides/img/flow.png`, {
        headers: { "If-None-Match": `W/${etag}` },
      });
      expect(weak.status).toBe(304);

      const stale = await app.request(`${base}/guides/img/flow.png`, {
        headers: { "If-None-Match": '"something-older"' },
      });
      expect(stale.status).toBe(200);
    });

    it("serves an SVG as an image under a sandboxing CSP", async () => {
      expect((await put(`${base}/diagram.svg`, SVG)).status).toBe(201);
      const res = await app.request(`${base}/diagram.svg`);
      expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
      // The fixture carries a <script>. Opened in its own tab, this header is
      // the only thing between that script and our origin.
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("sandbox");
    });

    it("serves a PDF inline, without the sandbox its viewer can't run in", async () => {
      expect((await put(`${base}/spec.pdf`, PDF)).status).toBe(201);
      const res = await app.request(`${base}/spec.pdf`);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toBe('inline; filename="spec.pdf"');
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
    });

    it("404s for an asset that doesn't exist", async () => {
      expect((await app.request(`${base}/missing.png`)).status).toBe(404);
    });

    it("serves a public space's assets to anyone, and a private space's to no one else", async () => {
      expect((await app.request(`${base}/guides/img/flow.png`)).status).toBe(200);

      const privateUrl = `/api/assets/${PRIVATE_SPACE}/default/secret.png`;
      expect((await put(privateUrl, png("secret"))).status).toBe(201);
      expect((await app.request(privateUrl, { headers: auth })).status).toBe(200);
      expect((await app.request(privateUrl)).status).toBe(403);

      const stranger = await createTestUser();
      expect((await app.request(privateUrl, { headers: stranger })).status).toBe(403);
      expect((await put(privateUrl, png("overwrite"), stranger)).status).toBe(403);
    });
  });

  describe("listing", () => {
    it("lists a space's assets with their sync metadata", async () => {
      const res = await app.request(`/api/assets/${SPACE}`);
      expect(res.status).toBe(200);
      const list = await res.json();
      expect(list.map((a: any) => a.path)).toEqual(
        expect.arrayContaining(["guides/img/flow.png", "diagram.svg", "spec.pdf"]),
      );
      const flow = list.find((a: any) => a.path === "guides/img/flow.png");
      expect(flow).toMatchObject({
        sectionSlug: "default",
        contentHash: sha256(png("second")),
        url: `/a/${SPACE}/default/guides/img/flow.png`,
      });
      // Where the bytes live is the server's business.
      expect(flow.storageKey).toBeUndefined();
    });

    it("filters by section", async () => {
      const res = await app.request(`/api/assets/${SPACE}?section=nope`);
      expect(await res.json()).toEqual([]);
    });

    it("hides a private space's listing from anyone without access", async () => {
      expect((await app.request(`/api/assets/${PRIVATE_SPACE}`)).status).toBe(403);
    });
  });

  describe("delete", () => {
    it("refuses an anonymous delete", async () => {
      const res = await app.request(`${base}/spec.pdf`, { method: "DELETE" });
      expect(res.status).toBe(403);
    });

    it("removes the asset", async () => {
      const res = await app.request(`${base}/spec.pdf`, { method: "DELETE", headers: auth });
      expect(res.status).toBe(200);
      expect((await app.request(`${base}/spec.pdf`)).status).toBe(404);
    });

    it("keeps bytes that another path still uses", async () => {
      // Storage is content-addressed, so these two paths share one blob.
      const bytes = png("shared");
      expect((await put(`${base}/copy-a.png`, bytes)).status).toBe(201);
      expect((await put(`${base}/copy-b.png`, bytes)).status).toBe(201);

      await app.request(`${base}/copy-a.png`, { method: "DELETE", headers: auth });

      const survivor = await app.request(`${base}/copy-b.png`);
      expect(survivor.status).toBe(200);
      expect(new Uint8Array(await survivor.arrayBuffer())).toEqual(bytes);
    });
  });

  describe("PDF export inlining", () => {
    async function inliner() {
      const space = await db.query.spaces.findFirst({ where: eq(spaces.slug, SPACE) });
      const section = await db.query.sections.findFirst({
        where: eq(sections.spaceId, space!.id),
      });
      return createAssetInliner(db, storage, space!.id, section!.id);
    }

    it("turns an image asset into a data: URI of its bytes", async () => {
      const inline = await inliner();
      const expected = Buffer.from(png("second")).toString("base64");
      expect(await inline("guides/img/flow.png")).toBe(`data:image/png;base64,${expected}`);
    });

    it("declines a missing asset", async () => {
      const inline = await inliner();
      expect(await inline("guides/img/missing.png")).toBeNull();
    });

    it("declines anything that isn't an image", async () => {
      expect((await put(`${base}/embedded.pdf`, PDF)).status).toBe(201);
      const inline = await inliner();
      expect(await inline("embedded.pdf")).toBeNull();
    });
  });
});
