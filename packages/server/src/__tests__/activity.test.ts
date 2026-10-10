import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { createDb, users, apiKeys } from "@sideways/db";
import { createStorage } from "@sideways/storage";
import type { SpaceEvent } from "@sideways/types";
import { createCommentRoutes } from "../routes/comments.js";
import { createDocumentRoutes } from "../routes/documents.js";
import { createSpaceRoutes } from "../routes/spaces.js";
import { authMiddleware } from "../middleware/auth.js";

const db = createDb(process.env.DATABASE_URL!);
const storage = createStorage({
  filerUrl: process.env.SEAWEEDFS_FILER_URL || "http://localhost:8888",
});

const app = new Hono();
app.use("*", authMiddleware(db));
app.route("/api/spaces", createSpaceRoutes(db));
app.route("/api/documents", createDocumentRoutes(db, storage));
app.route("/api/comments", createCommentRoutes(db));

type Auth = Record<string, string>;

async function api(path: string, options?: RequestInit) {
  const res = await app.request(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return { status: res.status, body: await res.json() };
}

const RUN = Date.now();
let seq = 0;

async function createKey(userId: string, actorName?: string): Promise<Auth> {
  const rawKey = `sk-${randomBytes(32).toString("base64url")}`;
  await db.insert(apiKeys).values({
    userId,
    name: "Test key",
    keyHash: createHash("sha256").update(rawKey).digest("hex"),
    prefix: rawKey.slice(0, 11),
    actorName,
  });
  return { Authorization: `Bearer ${rawKey}` };
}

async function createTestUser(name: string) {
  const tag = `${RUN}-${++seq}`;
  const [user] = await db
    .insert(users)
    .values({
      email: `activity-test-${tag}@sideways.dev`,
      name,
      hydraSubject: `kratos-activity-${tag}`,
    })
    .returning();
  return { id: user.id, auth: await createKey(user.id) };
}

async function createSpace(auth: Auth, visibility = "private"): Promise<string> {
  const slug = `activity-test-${RUN}-${++seq}`;
  await api(`/api/spaces/${slug}`, {
    method: "PUT",
    body: JSON.stringify({ name: "Activity Test", visibility }),
    headers: auth,
  });
  return slug;
}

function putDoc(space: string, path: string, body: object, auth: Auth) {
  return api(`/api/documents/${space}/default/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: auth,
  });
}

function patchDoc(space: string, path: string, body: object, auth: Auth) {
  return api(`/api/documents/${space}/default/${path}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: auth,
  });
}

/** The space's whole log, newest first. */
async function activity(space: string, auth: Auth): Promise<SpaceEvent[]> {
  const { status, body } = await api(`/api/spaces/${space}/activity`, { headers: auth });
  expect(status).toBe(200);
  return body.events;
}

let owner: Awaited<ReturnType<typeof createTestUser>>;
let other: Awaited<ReturnType<typeof createTestUser>>;

describe("Space activity log", () => {
  beforeAll(async () => {
    owner = await createTestUser("Activity Owner");
    other = await createTestUser("Activity Other");
  });

  describe("access", () => {
    it("refuses anonymous readers, even on a public space", async () => {
      const space = await createSpace(owner.auth, "public");
      const { status } = await api(`/api/spaces/${space}/activity`);
      expect(status).toBe(401);
    });

    it("lets any signed-in user read a public space's log", async () => {
      const space = await createSpace(owner.auth, "public");
      const { status } = await api(`/api/spaces/${space}/activity`, { headers: other.auth });
      expect(status).toBe(200);
    });

    it("refuses a signed-in user who cannot read the space", async () => {
      const space = await createSpace(owner.auth, "private");
      const { status } = await api(`/api/spaces/${space}/activity`, { headers: other.auth });
      expect(status).toBe(403);
    });

    it("returns 404 for an unknown space", async () => {
      const { status } = await api(`/api/spaces/no-such-space-${RUN}/activity`, { headers: owner.auth });
      expect(status).toBe(404);
    });
  });

  describe("document events", () => {
    it("logs a create, then an edit only when the content changes", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "# Guide\n\nOne." }, owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "# Guide\n\nTwo." }, owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "# Guide\n\nTwo." }, owner.auth);

      const events = await activity(space, owner.auth);
      expect(events.map((e) => e.type)).toEqual(["doc_edited", "doc_created"]);
      expect(events[0]).toMatchObject({
        actorId: owner.id,
        actorName: "Activity Owner",
        title: "Guide",
        url: `/s/${space}/default/guide`,
        detail: null,
        snippet: null,
      });
      expect(events[0].documentId).toBe(events[1].documentId);
    });

    it("attributes an agent key's edit to the agent", async () => {
      const space = await createSpace(owner.auth);
      const agent = await createKey(owner.id, "Scribe");
      await putDoc(space, "guide.md", { title: "Guide", content: "By an agent." }, agent);

      const [event] = await activity(space, owner.auth);
      expect(event.actorName).toBe("Scribe via Activity Owner");
      expect(event.actorId).toBe(owner.id);
    });

    it("logs a rename with the old and new title", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      await patchDoc(space, "guide.md", { title: "Handbook" }, owner.auth);
      // Same title again: nothing changed, nothing logged
      await patchDoc(space, "guide.md", { title: "Handbook" }, owner.auth);

      const events = await activity(space, owner.auth);
      expect(events.map((e) => e.type)).toEqual(["doc_renamed", "doc_created"]);
      expect(events[0]).toMatchObject({
        title: "Handbook",
        detail: { from: "Guide", to: "Handbook" },
      });
    });

    it("logs a rename made by saving a new title", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      await putDoc(space, "guide.md", { title: "Handbook" }, owner.auth);

      const events = await activity(space, owner.auth);
      expect(events.map((e) => e.type)).toEqual(["doc_renamed", "doc_created"]);
    });

    it("logs a move with the old and new path, and links to the new one", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      await patchDoc(space, "guide.md", { targetPath: "guides/intro.md" }, owner.auth);

      const events = await activity(space, owner.auth);
      expect(events.map((e) => e.type)).toEqual(["doc_moved", "doc_created"]);
      expect(events[0].detail).toEqual({ from: "default/guide.md", to: "default/guides/intro.md" });
      // The create is older than the move, but its link follows the document
      expect(events[1].url).toBe(`/s/${space}/default/guides/intro`);
    });

    it("logs a rename and a move made in one request as two events", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      await patchDoc(space, "guide.md", { title: "Handbook", targetPath: "handbook.md" }, owner.auth);

      const events = await activity(space, owner.auth);
      expect(events.slice(0, 2).map((e) => e.type).sort()).toEqual(["doc_moved", "doc_renamed"]);
    });

    it("logs nothing for a tag or position change", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      await patchDoc(space, "guide.md", { tags: ["a"], position: 3 }, owner.auth);

      const events = await activity(space, owner.auth);
      expect(events.map((e) => e.type)).toEqual(["doc_created"]);
    });

    it("keeps a deleted document's events, unlinked", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      await api(`/api/documents/${space}/default/guide.md`, { method: "DELETE", headers: owner.auth });

      const events = await activity(space, owner.auth);
      expect(events.map((e) => e.type)).toEqual(["doc_deleted", "doc_created"]);
      expect(events.map((e) => e.url)).toEqual([null, null]);
      expect(events[0].title).toBe("Guide");
      expect(events[0].documentId).toBe(events[1].documentId);
    });

    it("logs a duplicate as a new document", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      await api(`/api/documents/${space}/default/_duplicate/guide.md`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: owner.auth,
      });

      const events = await activity(space, owner.auth);
      expect(events.map((e) => e.type)).toEqual(["doc_created", "doc_created"]);
      expect(events[0].title).toBe("Guide (copy)");
    });

    it("logs a move between spaces on both sides, linked only where the document now is", async () => {
      const source = await createSpace(owner.auth);
      const target = await createSpace(owner.auth);
      await putDoc(source, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      await patchDoc(source, "guide.md", { targetSpace: target }, owner.auth);

      const sourceEvents = await activity(source, owner.auth);
      expect(sourceEvents.map((e) => e.type)).toEqual(["doc_moved_out", "doc_created"]);
      expect(sourceEvents.map((e) => e.url)).toEqual([null, null]);

      const targetEvents = await activity(target, owner.auth);
      expect(targetEvents.map((e) => e.type)).toEqual(["doc_moved_in"]);
      expect(targetEvents[0].url).toBe(`/s/${target}/default/guide`);
    });

    it("logs a move for every document when a section is emptied", async () => {
      const space = await createSpace(owner.auth);
      await api(`/api/spaces/${space}/sections/guides`, {
        method: "PUT",
        body: JSON.stringify({ title: "Guides" }),
        headers: owner.auth,
      });
      for (const name of ["one", "two"]) {
        await api(`/api/documents/${space}/guides/${name}.md`, {
          method: "PUT",
          body: JSON.stringify({ title: name, content: "Body." }),
          headers: owner.auth,
        });
      }
      await api(`/api/spaces/${space}/sections/guides/empty`, { method: "POST", headers: owner.auth });

      const moves = (await activity(space, owner.auth)).filter((e) => e.type === "doc_moved");
      expect(moves.map((e) => e.detail).sort((a, b) => a!.from.localeCompare(b!.from))).toEqual([
        { from: "guides/one.md", to: "default/one.md" },
        { from: "guides/two.md", to: "default/two.md" },
      ]);
    });
  });

  describe("comment events", () => {
    it("logs a comment with a plain-text snippet and a link to it", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      const { body: comment } = await api(`/api/comments/${space}/default/guide.md`, {
        method: "POST",
        body: JSON.stringify({ body: "This is **wrong**,\nsee [the spec](https://example.com)." }),
        headers: owner.auth,
      });

      const [event] = await activity(space, owner.auth);
      expect(event).toMatchObject({
        type: "comment_created",
        title: "Guide",
        snippet: "This is wrong, see the spec.",
        url: `/s/${space}/default/guide#comment-${comment.id}`,
      });
    });

    it("shows a comment as it reads now, and drops its text once deleted", async () => {
      const space = await createSpace(owner.auth);
      await putDoc(space, "guide.md", { title: "Guide", content: "Body." }, owner.auth);
      const { body: comment } = await api(`/api/comments/${space}/default/guide.md`, {
        method: "POST",
        body: JSON.stringify({ body: "First draft." }),
        headers: owner.auth,
      });

      await api(`/api/comments/${comment.id}`, {
        method: "PUT",
        body: JSON.stringify({ body: "Second draft." }),
        headers: owner.auth,
      });
      let events = await activity(space, owner.auth);
      expect(events.map((e) => e.type)).toEqual(["comment_created", "doc_created"]);
      expect(events[0].snippet).toBe("Second draft.");

      await api(`/api/comments/${comment.id}`, { method: "DELETE", headers: owner.auth });
      events = await activity(space, owner.auth);
      expect(events[0]).toMatchObject({
        type: "comment_created",
        snippet: null,
        url: `/s/${space}/default/guide`,
      });
    });
  });

  describe("paging", () => {
    it("pages back through the whole log without gaps or repeats", async () => {
      const space = await createSpace(owner.auth);
      for (let i = 0; i < 5; i++) {
        await putDoc(space, `doc-${i}.md`, { title: `Doc ${i}`, content: "Body." }, owner.auth);
      }

      const titles: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor ? `?limit=2&before=${cursor}` : "?limit=2";
        const { body } = await api(`/api/spaces/${space}/activity${query}`, { headers: owner.auth });
        titles.push(...body.events.map((e: SpaceEvent) => e.title));
        cursor = body.nextCursor;
        pages++;
      } while (cursor);

      expect(titles).toEqual(["Doc 4", "Doc 3", "Doc 2", "Doc 1", "Doc 0"]);
      expect(pages).toBe(3);
    });

    it("rejects a malformed cursor", async () => {
      const space = await createSpace(owner.auth);
      const { status } = await api(`/api/spaces/${space}/activity?before=not-a-uuid`, { headers: owner.auth });
      expect(status).toBe(400);
    });

    it("ignores a cursor from another space", async () => {
      const first = await createSpace(owner.auth);
      const second = await createSpace(owner.auth);
      await putDoc(first, "a.md", { title: "A", content: "Body." }, owner.auth);
      await putDoc(second, "b.md", { title: "B", content: "Body." }, owner.auth);
      const [foreign] = await activity(second, owner.auth);

      const { body } = await api(`/api/spaces/${first}/activity?before=${foreign.id}`, { headers: owner.auth });
      expect(body.events).toEqual([]);
    });
  });
});
