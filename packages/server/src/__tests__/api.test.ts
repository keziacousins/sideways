import { describe, it, expect, beforeAll } from "vitest";

/**
 * Integration tests against the running API server.
 * Requires: API running on localhost:4100, backed by real Postgres.
 */

const API = "http://localhost:4100";

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return { status: res.status, body: await res.json() };
}

const TEST_SPACE = `test-${Date.now()}`;
const TEST_SLUG = "test-doc";

describe("API integration", () => {
  beforeAll(async () => {
    // Verify API is reachable
    const { body } = await api("/health");
    expect(body.status).toBe("ok");
  });

  describe("spaces", () => {
    it("creates a space", async () => {
      const { status, body } = await api(`/api/spaces/${TEST_SPACE}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Test Space",
          description: "Integration test space",
          visibility: "private",
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
        `/api/documents/${TEST_SPACE}/${TEST_SLUG}`,
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
      expect(body.slug).toBe(TEST_SLUG);
    });

    it("lists documents in a space", async () => {
      const { body } = await api(`/api/documents?space=${TEST_SPACE}`);
      expect(body.length).toBe(1);
      expect(body[0].slug).toBe(TEST_SLUG);
    });

    it("gets a document with content", async () => {
      const { body } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SLUG}`,
      );
      expect(body.title).toBe("Test Document");
      expect(body.content).toContain("# Test");
    });

    it("renders a document to HTML", async () => {
      const { body } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SLUG}/render`,
      );
      expect(body.html).toContain("<h1");
      expect(body.html).toContain("Test");
    });

    it("creates a new version on content change", async () => {
      await api(`/api/documents/${TEST_SPACE}/${TEST_SLUG}`, {
        method: "PUT",
        body: JSON.stringify({
          content: "# Test\n\nUpdated content.",
        }),
      });

      const { body: versions } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SLUG}/versions`,
      );
      expect(versions.length).toBe(2);
      expect(versions[0].version).toBe(2);
    });

    it("deduplicates identical content", async () => {
      // Push same content again
      await api(`/api/documents/${TEST_SPACE}/${TEST_SLUG}`, {
        method: "PUT",
        body: JSON.stringify({
          content: "# Test\n\nUpdated content.",
        }),
      });

      const { body: versions } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SLUG}/versions`,
      );
      expect(versions.length).toBe(2); // still 2, not 3
    });

    it("auto-creates space on document PUT", async () => {
      const autoSpace = `auto-${Date.now()}`;
      const { status } = await api(
        `/api/documents/${autoSpace}/some-doc`,
        {
          method: "PUT",
          body: JSON.stringify({
            title: "Auto-created",
            content: "# Auto",
          }),
        },
      );
      expect(status).toBe(201);

      // Space should exist now
      const { body: space } = await api(`/api/spaces/${autoSpace}`);
      expect(space.slug).toBe(autoSpace);

      // Clean up
      await api(`/api/documents/${autoSpace}/some-doc`, {
        method: "DELETE",
      });
    });

    it("returns 404 for non-existent document", async () => {
      const { status } = await api(
        `/api/documents/${TEST_SPACE}/nonexistent`,
      );
      expect(status).toBe(404);
    });

    it("returns 404 for non-existent space", async () => {
      const { status } = await api(
        `/api/documents/no-such-space/no-doc`,
      );
      expect(status).toBe(404);
    });

    it("deletes a document", async () => {
      const { body } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SLUG}`,
        { method: "DELETE" },
      );
      expect(body.deleted).toBe(true);

      const { status } = await api(
        `/api/documents/${TEST_SPACE}/${TEST_SLUG}`,
      );
      expect(status).toBe(404);
    });
  });
});
