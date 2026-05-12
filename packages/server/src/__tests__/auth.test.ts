import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { createDb, users, apiKeys } from "@sideways/db";
import { createStorage } from "@sideways/storage";
import { createAuthRoutes } from "../routes/auth.js";
import { createKeyRoutes } from "../routes/keys.js";
import { createDocumentRoutes } from "../routes/documents.js";
import { createSpaceRoutes } from "../routes/spaces.js";
import { authMiddleware } from "../middleware/auth.js";

const db = createDb(process.env.DATABASE_URL!);
const storage = createStorage({
  filerUrl: process.env.SEAWEEDFS_FILER_URL || "http://localhost:8888",
});

const app = new Hono();
app.use("*", authMiddleware(db));
app.route("/auth", createAuthRoutes(db));
app.route("/api/keys", createKeyRoutes(db));
app.route("/api/spaces", createSpaceRoutes(db));
app.route("/api/documents", createDocumentRoutes(db, storage));

async function api(path: string, options?: RequestInit) {
  const res = await app.request(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return { status: res.status, body: await res.json() };
}

/** Create a test user and API key, return the Bearer header */
async function createTestUserWithKey(): Promise<{
  userId: string;
  apiKey: string;
  authHeader: Record<string, string>;
}> {
  // Insert user directly
  const [user] = await db
    .insert(users)
    .values({
      email: `test-${Date.now()}@sideways.dev`,
      name: "Test Auth User",
      hydraSubject: `kratos-${Date.now()}`,
    })
    .returning();

  // Create an API key
  const rawKey = `sk-${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  await db.insert(apiKeys).values({
    userId: user.id,
    name: "Test key",
    keyHash,
    prefix: rawKey.slice(0, 11),
  });

  return {
    userId: user.id,
    apiKey: rawKey,
    authHeader: { Authorization: `Bearer ${rawKey}` },
  };
}

describe("Auth", () => {
  describe("registration webhook", () => {
    it("creates a local user from Kratos webhook", async () => {
      const identityId = `kratos-webhook-${Date.now()}`;
      const email = `webhook-${Date.now()}@sideways.dev`;

      const { status } = await api("/auth/hooks/registration", {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          email,
          name: "Webhook User",
        }),
      });

      expect(status).toBe(200);

      // Verify user was created
      const user = await db.query.users.findFirst({
        where: eq(users.hydraSubject, identityId),
      });
      expect(user).toBeDefined();
      expect(user!.email).toBe(email);
      expect(user!.name).toBe("Webhook User");
    });

    it("is idempotent — doesn't duplicate users", async () => {
      const identityId = `kratos-idempotent-${Date.now()}`;
      const email = `idempotent-${Date.now()}@sideways.dev`;
      const body = JSON.stringify({
        identity_id: identityId,
        email,
        name: "Idempotent User",
      });

      await api("/auth/hooks/registration", { method: "POST", body });
      await api("/auth/hooks/registration", { method: "POST", body });

      // Should only have one user with this subject
      const allUsers = await db.query.users.findMany({
        where: eq(users.hydraSubject, identityId),
      });
      expect(allUsers.length).toBe(1);
    });
  });

  describe("API keys", () => {
    it("rejects unauthenticated key creation", async () => {
      const { status } = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name: "My key" }),
      });
      expect(status).toBe(401);
    });

    it("creates an API key for authenticated user", async () => {
      const { authHeader } = await createTestUserWithKey();

      const { status, body } = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name: "Second key" }),
        headers: authHeader,
      });

      expect(status).toBe(201);
      expect(body.key).toMatch(/^sk-/);
      expect(body.name).toBe("Second key");
    });

    it("lists keys for authenticated user", async () => {
      const { authHeader } = await createTestUserWithKey();

      const { status, body } = await api("/api/keys", {
        headers: authHeader,
      });

      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      // Should not expose the raw key
      expect(body[0].keyHash).toBeUndefined();
    });

    it("authenticates API requests with the key", async () => {
      const { authHeader } = await createTestUserWithKey();

      // Create a space using the API key
      const spaceSlug = `key-test-${Date.now()}`;
      const { status } = await api(`/api/spaces/${spaceSlug}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Key Test Space", visibility: "private" }),
        headers: authHeader,
      });

      expect(status).toBe(201);
    });

    it("revokes an API key", async () => {
      const { authHeader } = await createTestUserWithKey();

      // Create a second key
      await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name: "To revoke" }),
        headers: authHeader,
      });

      // List to get the ID
      const { body: keys } = await api("/api/keys", {
        headers: authHeader,
      });
      const toRevoke = keys.find((k: any) => k.name === "To revoke");

      const { status } = await api(`/api/keys/${toRevoke.id}`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(status).toBe(200);
    });
  });

  describe("visibility with auth", () => {
    it("allows authenticated user to read private space they own", async () => {
      const { authHeader } = await createTestUserWithKey();

      // Create a private space
      const spaceSlug = `private-${Date.now()}`;
      await api(`/api/spaces/${spaceSlug}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Private", visibility: "private" }),
        headers: authHeader,
      });

      // Create a doc in it
      await api(`/api/documents/${spaceSlug}/secret-doc`, {
        method: "PUT",
        body: JSON.stringify({ title: "Secret", content: "# Secret" }),
        headers: authHeader,
      });

      // Read with auth — should work
      const { status, body } = await api(
        `/api/documents/${spaceSlug}/secret-doc`,
        { headers: authHeader },
      );
      expect(status).toBe(200);
      expect(body.title).toBe("Secret");
    });

    it("blocks anonymous access to private space", async () => {
      const { authHeader } = await createTestUserWithKey();

      const spaceSlug = `anon-blocked-${Date.now()}`;
      await api(`/api/spaces/${spaceSlug}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Private", visibility: "private" }),
        headers: authHeader,
      });

      await api(`/api/documents/${spaceSlug}/doc`, {
        method: "PUT",
        body: JSON.stringify({ title: "Hidden", content: "# Hidden" }),
        headers: authHeader,
      });

      // Try without auth
      const { status } = await api(`/api/documents/${spaceSlug}/doc`);
      expect(status).toBe(403);
    });

    it("blocks different user from private space", async () => {
      const owner = await createTestUserWithKey();
      const other = await createTestUserWithKey();

      const spaceSlug = `other-blocked-${Date.now()}`;
      await api(`/api/spaces/${spaceSlug}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Owner Only", visibility: "private" }),
        headers: owner.authHeader,
      });

      await api(`/api/documents/${spaceSlug}/doc`, {
        method: "PUT",
        body: JSON.stringify({ title: "Private", content: "# Private" }),
        headers: owner.authHeader,
      });

      // Other user tries to read
      const { status } = await api(`/api/documents/${spaceSlug}/doc`, {
        headers: other.authHeader,
      });
      expect(status).toBe(403);
    });

    it("allows any authenticated user to read org space", async () => {
      const owner = await createTestUserWithKey();
      const other = await createTestUserWithKey();

      const spaceSlug = `org-${Date.now()}`;
      await api(`/api/spaces/${spaceSlug}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Org Space", visibility: "org" }),
        headers: owner.authHeader,
      });

      await api(`/api/documents/${spaceSlug}/doc`, {
        method: "PUT",
        body: JSON.stringify({ title: "Org Doc", content: "# Org" }),
        headers: owner.authHeader,
      });

      // Other authenticated user can read
      const { status, body } = await api(`/api/documents/${spaceSlug}/doc`, {
        headers: other.authHeader,
      });
      expect(status).toBe(200);
      expect(body.title).toBe("Org Doc");
    });
  });
});
