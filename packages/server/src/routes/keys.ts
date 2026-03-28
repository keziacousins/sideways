import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { type Database, apiKeys } from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

export function createKeyRoutes(db: Database) {
  const router = new Hono();

  // All key routes require authentication
  router.use("*", requireAuth());

  /** Create a new API key */
  router.post("/", async (c) => {
    const user = c.get("user") as AuthUser;
    const body = await c.req.json<{ name?: string; actorName?: string }>();

    // Generate raw key
    const rawKey = `sk-${randomBytes(32).toString("base64url")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 11); // "sk-" + 8 chars

    await db.insert(apiKeys).values({
      userId: user.id,
      name: body.name || "Untitled key",
      keyHash,
      prefix,
      actorName: body.actorName || null,
    });

    // Return the raw key — this is the only time it's shown
    return c.json({
      key: rawKey,
      prefix,
      name: body.name || "Untitled key",
      actorName: body.actorName || null,
    }, 201);
  });

  /** List current user's API keys (never shows the raw key) */
  router.get("/", async (c) => {
    const user = c.get("user") as AuthUser;

    const keys = await db.query.apiKeys.findMany({
      where: eq(apiKeys.userId, user.id),
      columns: {
        id: true,
        name: true,
        prefix: true,
        actorName: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return c.json(keys);
  });

  /** Revoke (delete) an API key */
  router.delete("/:id", async (c) => {
    const user = c.get("user") as AuthUser;
    const keyId = c.req.param("id");

    const key = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, keyId),
    });

    if (!key || key.userId !== user.id) {
      return c.json({ error: "Not found" }, 404);
    }

    await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
    return c.json({ deleted: true });
  });

  return router;
}
