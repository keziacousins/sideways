import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { type Database, users } from "@sideways/db";
import { env } from "../env.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
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
        c.set("user", user);
        return next();
      }

      // JWT path
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: env.hydraPublicUrl,
        });

        // Custom claims injected at consent
        const ext = (payload as any).ext || {};
        if (ext.user_id) {
          c.set("user", {
            id: ext.user_id,
            email: ext.email || "",
            name: ext.name || "",
          });
        } else if (payload.sub) {
          // Fall back to looking up by Hydra subject
          const user = await db.query.users.findFirst({
            where: eq(users.hydraSubject, payload.sub),
          });
          c.set(
            "user",
            user
              ? { id: user.id, email: user.email, name: user.name }
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
  // Import dynamically to avoid circular deps
  const { createHash } = await import("node:crypto");
  const keyHash = createHash("sha256").update(key).digest("hex");

  // Query the api_keys table (will be created in the next step)
  try {
    const result = await db.execute(
      `SELECT u.id, u.email, u.name
       FROM api_keys k JOIN users u ON k.user_id = u.id
       WHERE k.key_hash = $1 AND (k.expires_at IS NULL OR k.expires_at > NOW())`,
      [keyHash],
    ) as any;

    if (result.length > 0) {
      // Update last_used_at
      db.execute(
        `UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1`,
        [keyHash],
      ).catch(() => {});

      return {
        id: result[0].id,
        email: result[0].email,
        name: result[0].name,
      };
    }
  } catch {
    // api_keys table might not exist yet
  }

  return null;
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
