import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { eq, isNotNull, and } from "drizzle-orm";
import { createDb, users, apiKeys, documents, documentVersions, spaces } from "@sideways/db";
import { createStorage } from "@sideways/storage";
import { createDocumentRoutes } from "../routes/documents.js";
import { createSpaceRoutes } from "../routes/spaces.js";
import { authMiddleware } from "../middleware/auth.js";

/**
 * Relative links between documents, through the real render route: what
 * matters here is not the resolution rules (shared/markdown covers those)
 * but that a cached render is thrown away when a link's target appears or
 * disappears.
 */

const db = createDb(process.env.DATABASE_URL!);
const storage = createStorage({
  filerUrl: process.env.SEAWEEDFS_FILER_URL || "http://localhost:8888",
});

const app = new Hono();
app.use("*", authMiddleware(db));
app.route("/api/spaces", createSpaceRoutes(db));
app.route("/api/documents", createDocumentRoutes(db, storage));

const SPACE = `doclinks-${Date.now()}`;
let auth: Record<string, string>;

async function json(path: string, method = "GET", body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const putDoc = (section: string, path: string, content: string) =>
  json(`/api/documents/${SPACE}/${section}/${path}`, "PUT", { content });

async function render(section: string, path: string): Promise<string> {
  const { status, body } = await json(`/api/documents/${SPACE}/${section}/_render/${path}`);
  expect(status).toBe(200);
  return body.html;
}

/**
 * The render route stores its HTML in the background. Wait for that write to
 * land for the document at `path`, so the structural change that follows has
 * a cache entry to invalidate — otherwise the late write could arrive after
 * the invalidation and bring the old HTML back.
 */
async function cacheSettled(path: string) {
  const space = await db.query.spaces.findFirst({ where: eq(spaces.slug, SPACE) });
  for (let i = 0; i < 60; i++) {
    const cached = await db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .innerJoin(documents, eq(documentVersions.documentId, documents.id))
      .where(
        and(
          eq(documents.spaceId, space!.id),
          eq(documents.path, path),
          isNotNull(documentVersions.renderedKey),
        ),
      );
    if (cached.length > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`render of ${path} was never cached`);
}

describe("relative document links through the render route", () => {
  beforeAll(async () => {
    const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const [user] = await db
      .insert(users)
      .values({
        email: `doclinks-test-${unique}@sideways.dev`,
        name: "Doc Links Tester",
        hydraSubject: `kratos-doclinks-${unique}`,
      })
      .returning();
    const rawKey = `sk-${randomBytes(32).toString("base64url")}`;
    await db.insert(apiKeys).values({
      userId: user.id,
      name: "Test key",
      keyHash: createHash("sha256").update(rawKey).digest("hex"),
      prefix: rawKey.slice(0, 11),
    });
    auth = { Authorization: `Bearer ${rawKey}` };

    expect((await json(`/api/spaces/${SPACE}`, "PUT", { name: SPACE, visibility: "public" })).status).toBe(201);
    expect((await json(`/api/spaces/${SPACE}/sections/platform`, "PUT", { title: "Platform" })).status).toBe(201);
  });

  it("resolves links from an index page, to an index page, and across sections", async () => {
    await putDoc("default", "guides/index.md", "# Guides\n\n[Auth](auth.md) [Deep](deep/index.md) [API](../../platform/api.md)");
    await putDoc("default", "guides/auth.md", "# Auth\n\n[Up](index.md)");
    await putDoc("default", "guides/deep/index.md", "# Deep");
    await putDoc("platform", "api.md", "# API");

    const html = await render("default", "guides/index.md");
    expect(html).toContain(`href="/s/${SPACE}/default/guides/auth"`);
    expect(html).toContain(`href="/s/${SPACE}/default/guides/deep"`);
    expect(html).toContain(`href="/s/${SPACE}/platform/api"`);
    expect(await render("default", "guides/auth.md")).toContain(`href="/s/${SPACE}/default/guides"`);
  });

  it("starts resolving a link when its target is pushed afterwards", async () => {
    await putDoc("default", "early.md", "# Early\n\n[Later](later.md)");
    expect(await render("default", "early.md")).toContain("doc-link-unresolved");
    await cacheSettled("early.md");

    await putDoc("default", "later.md", "# Later");
    const html = await render("default", "early.md");
    expect(html).toContain(`href="/s/${SPACE}/default/later"`);
    expect(html).not.toContain("doc-link-unresolved");
  });

  it("stops resolving it when the target is deleted", async () => {
    await cacheSettled("early.md");
    expect((await json(`/api/documents/${SPACE}/default/later.md`, "DELETE")).status).toBe(200);
    expect(await render("default", "early.md")).toContain("doc-link-unresolved");
  });

  it("previews unsaved markdown with the same resolution", async () => {
    const { status, body } = await json(
      `/api/documents/${SPACE}/default/_render/guides/index.md`,
      "POST",
      { content: "[Auth](auth.md) [Nope](nope.md)" },
    );
    expect(status).toBe(200);
    expect(body.html).toContain(`href="/s/${SPACE}/default/guides/auth"`);
    expect(body.html).toContain('<span class="doc-link-unresolved">Nope</span>');
  });
});
