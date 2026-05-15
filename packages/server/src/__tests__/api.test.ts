import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createDb } from "@sideways/db";
import { createStorage } from "@sideways/storage";
import { createDocumentRoutes } from "../routes/documents.js";
import { createSpaceRoutes } from "../routes/spaces.js";

/**
 * Integration tests against a real Postgres (sideways_test database).
 * Uses Hono's test client — no HTTP server needed.
 */

const db = createDb(process.env.DATABASE_URL!);
const storage = createStorage({
  filerUrl: process.env.SEAWEEDFS_FILER_URL || "http://localhost:8888",
});

const app = new Hono();
app.route("/api/spaces", createSpaceRoutes(db));
app.route("/api/documents", createDocumentRoutes(db, storage));

async function api(path: string, options?: RequestInit) {
  const res = await app.request(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return { status: res.status, body: await res.json() };
}

const TEST_SPACE = `test-${Date.now()}`;
const TEST_SECTION = "default";
const TEST_PATH = "test-doc.md";

describe("API integration", () => {
  describe("spaces", () => {
    it("creates a space", async () => {
      const { status, body } = await api(`/api/spaces/${TEST_SPACE}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Test Space",
          description: "Integration test space",
          visibility: "public",
        }),
      });
      expect(status).toBe(201);
      expect(body.slug).toBe(TEST_SPACE);
      expect(body.name).toBe("Test Space");
    });

    it("lists spaces", async () => {
      const { body } = await api("/api/spaces");
      const found = body.find((s: any) => s.slug === TEST_SPACE);
      expect(found).toBeDefined();
    });

    it("gets a space by slug", async () => {
      const { body } = await api(`/api/spaces/${TEST_SPACE}`);
      expect(body.slug).toBe(TEST_SPACE);
    });

    it("updates a space", async () => {
      const { status, body } = await api(`/api/spaces/${TEST_SPACE}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated Test Space" }),
      });
      expect(status).toBe(200);
      expect(body.name).toBe("Updated Test Space");
    });
  });

  describe("documents", () => {
    it("creates a document", async () => {
      const { status, body } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SECTION}/${TEST_PATH}`,
        {
          method: "PUT",
          body: JSON.stringify({
            title: "Test Document",
            content: "# Test\n\nHello from integration tests.",
            tags: ["test"],
          }),
        },
      );
      expect(status).toBe(201);
      expect(body.path).toBe(TEST_PATH);
      expect(body.url).toBe(`/s/${TEST_SPACE}/${TEST_SECTION}/test-doc`);
    });

    it("lists documents in a space", async () => {
      const { body } = await api(`/api/documents?space=${TEST_SPACE}`);
      expect(body.length).toBe(1);
      expect(body[0].path).toBe(TEST_PATH);
      expect(body[0].sectionSlug).toBe(TEST_SECTION);
      expect(body[0].url).toBe(`/s/${TEST_SPACE}/${TEST_SECTION}/test-doc`);
    });

    it("gets a document with content", async () => {
      const { body } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SECTION}/${TEST_PATH}`,
      );
      expect(body.title).toBe("Test Document");
      expect(body.content).toContain("# Test");
    });

    it("renders a document to HTML", async () => {
      const { body } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SECTION}/_render/${TEST_PATH}`,
      );
      expect(body.html).toContain("<h1");
      expect(body.html).toContain("Test");
    });

    it("creates a new version on content change", async () => {
      await api(`/api/documents/${TEST_SPACE}/${TEST_SECTION}/${TEST_PATH}`, {
        method: "PUT",
        body: JSON.stringify({
          content: "# Test\n\nUpdated content.",
        }),
      });

      const { body: versions } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SECTION}/_versions/${TEST_PATH}`,
      );
      expect(versions.length).toBe(2);
      expect(versions[0].version).toBe(2);
    });

    it("deduplicates identical content", async () => {
      await api(`/api/documents/${TEST_SPACE}/${TEST_SECTION}/${TEST_PATH}`, {
        method: "PUT",
        body: JSON.stringify({
          content: "# Test\n\nUpdated content.",
        }),
      });

      const { body: versions } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SECTION}/_versions/${TEST_PATH}`,
      );
      expect(versions.length).toBe(2);
    });

    it("returns 404 when the space doesn't exist", async () => {
      const { status } = await api(
        `/api/documents/no-such-space/${TEST_SECTION}/anything.md`,
        {
          method: "PUT",
          body: JSON.stringify({ title: "x", content: "x" }),
        },
      );
      expect(status).toBe(404);
    });

    it("returns 404 for non-existent document", async () => {
      const { status } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SECTION}/nonexistent.md`,
      );
      expect(status).toBe(404);
    });

    it("returns 404 for non-existent space", async () => {
      const { status } = await api(
        `/api/documents/no-such-space/default/no-doc.md`,
      );
      expect(status).toBe(404);
    });

    it("rejects anonymous delete (requires write access)", async () => {
      const { status } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SECTION}/${TEST_PATH}`,
        { method: "DELETE" },
      );
      expect(status).toBe(403);
    });
  });
});
