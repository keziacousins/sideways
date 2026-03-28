import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { type Database, users, apiKeys } from "@sideways/db";
import { env } from "../env.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** If acting via an API key with actorName, this is the agent/bot name */
  actorName?: string;
  /** Display name: actorName if set, otherwise user name */
  displayName: string;
}

/** Cached JWKS fetcher — validates JWT signatures against Hydra's public keys */
const JWKS = createRemoteJWKSet(
  new URL(`${env.hydraPublicUrl}/.well-known/jwks.json`),
);

/**
 * Auth middleware — validates Bearer tokens.
 *
 * Supports two token types:
 * 1. JWT access tokens from Hydra (validated via JWKS, stateless)
 * 2. API keys (sk-... prefix, validated against DB)
 *
 * Sets c.get("user") on success, null for anonymous requests.
 */
export function authMiddleware(db: Database) {
  return createMiddleware<{ Variables: { user: AuthUser | null } }>(
    async (c, next) => {
      const authHeader = c.req.header("Authorization");

      if (!authHeader?.startsWith("Bearer ")) {
        c.set("user", null);
        return next();
      }

      const token = authHeader.slice(7);

      // API key path
      if (token.startsWith("sk-")) {
        const user = await resolveApiKey(db, token);
        // X-Sideways-Actor header overrides display name (e.g. CLI --as flag)
        const actorOverride = c.req.header("X-Sideways-Actor");
        if (user && actorOverride) {
          user.actorName = actorOverride;
          user.displayName = actorOverride;
        }
        c.set("user", user);
        return next();
      }

      // JWT path
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: env.hydraIssuerUrl,
        });

        // Custom claims injected at consent
        const ext = (payload as any).ext || {};
        if (ext.user_id) {
          const name = ext.name || "";
          c.set("user", {
            id: ext.user_id,
            email: ext.email || "",
            name,
            displayName: name,
          });
        } else if (payload.sub) {
          // Fall back to looking up by Hydra subject
          const user = await db.query.users.findFirst({
            where: eq(users.hydraSubject, payload.sub),
          });
          c.set(
            "user",
            user
              ? { id: user.id, email: user.email, name: user.name, displayName: user.name }
              : null,
          );
        } else {
          c.set("user", null);
        }
      } catch {
        c.set("user", null);
      }

      return next();
    },
  );
}

/**
 * Look up a user by API key.
 * API keys are stored as hashed values; we hash the input and compare.
 */
async function resolveApiKey(
  db: Database,
  key: string,
): Promise<AuthUser | null> {
  const keyHash = createHash("sha256").update(key).digest("hex");

  try {
    const apiKey = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.keyHash, keyHash),
    });

    if (!apiKey) return null;

    // Check expiry
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;

    // Look up user
    const user = await db.query.users.findFirst({
      where: eq(users.id, apiKey.userId),
    });

    if (!user) return null;

    // Update last_used_at (fire and forget)
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKey.id))
      .catch(() => {});

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      actorName: apiKey.actorName || undefined,
      displayName: apiKey.actorName || user.name,
    };
  } catch {
    return null;
  }
}

/**
 * Require authentication — returns 401 if no valid user.
 */
export function requireAuth() {
  return createMiddleware<{ Variables: { user: AuthUser | null } }>(
    async (c, next) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return next();
    },
  );
}
