import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { type Database, users, apiKeys } from "@sideways/db";
import { env } from "../env.js";
import { INTERNAL_AUTH_HEADER, isLoopback, verifyInternalToken } from "./internalAuth.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** If acting via an API key with actorName, this is the agent/bot name */
  actorName?: string;
  /** Display name: actorName if set, otherwise user name */
  displayName: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser | null;
  }
}

/**
 * Names an actor identity cannot impersonate. Three flavours of reserve:
 *  - Built-in/admin identities the product itself uses or is likely to use.
 *  - Vendor/AI brand names a DCR'd client's `client_name` would otherwise
 *    let an attacker register and route into the actor field unchecked.
 *  - The product name and common variations.
 *
 * Comparison is against the NFKC-normalised, lowercase, whitespace-collapsed
 * form of the supplied name — homoglyph and spacing tricks don't bypass it.
 */
const RESERVED_ACTOR_NAMES = new Set([
  // Built-in / admin
  "system",
  "sideways",
  "sideways system",
  "sideways bot",
  "admin",
  "administrator",
  "root",
  "anonymous",
  "moderator",
  "support",
  "owner",
  "user",
  "official",
  // AI / agent brand names commonly impersonated in comment phishing
  "claude",
  "anthropic",
  "openai",
  "chatgpt",
  "gpt",
  "gpt-4",
  "gpt-5",
  "copilot",
  "github copilot",
  "gemini",
  "google",
  "deepmind",
  "meta",
  "llama",
  "mistral",
  "perplexity",
  "ai",
  "bot",
  "assistant",
  "agent",
  "connector",
]);

/**
 * Normalise and validate an actor name supplied via the X-Sideways-Actor
 * header or a DCR'd client's `client_name`. Returns the cleaned name, or
 * null if it's unusable (empty after stripping, too long, control
 * characters, or on the reserved list).
 *
 * Normalisation order matters: control-strip → NFKC → collapse internal
 * whitespace → compare against reserved names in lowercase. Without NFKC,
 * Cyrillic 'а' (U+0430) reading as Latin 'a' bypasses the list. Without
 * whitespace collapse, "claude  bot" reaches the actor field.
 */
export function sanitiseActorName(raw: string): string | null {
  const stripped = raw
    .replace(/\p{C}/gu, "")      // C0/C1 controls, format marks, surrogates
    .normalize("NFKC")             // canonical compatibility form
    .replace(/\s+/g, " ")         // collapse runs of whitespace
    .trim();
  if (!stripped || stripped.length > 50) return null;
  if (RESERVED_ACTOR_NAMES.has(stripped.toLowerCase())) return null;
  return stripped;
}

/**
 * Looser sanitiser for OAuth client_name (e.g. on DCR). Same hygiene as
 * sanitiseActorName — control-strip, NFKC, whitespace collapse, length
 * cap — but no reserved-name check. The reserved list exists to stop
 * impersonation in the *actor* field; for DCR'd clients the client_name
 * never reaches actor (see actorNameForConsent's `metadata.dcr` guard).
 * It surfaces only on the consent UI alongside an "Unverified
 * third-party connector" badge, so genuinely-named connectors ("Claude",
 * "Anthropic", "Copilot") shouldn't be blocked at registration time.
 */
export function sanitiseClientName(raw: string, maxLength: number): string | null {
  const stripped = raw
    .replace(/\p{C}/gu, "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped || stripped.length > maxLength) return null;
  return stripped;
}

/** Cached JWKS fetcher — validates JWT signatures against Hydra's public keys */
export const JWKS = createRemoteJWKSet(
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
      // Internal loopback auth — used by the MCP layer to invoke /api/*
      // routes on behalf of a JWT-validated user without forwarding the
      // user's MCP-audience token (see middleware/internalAuth.ts).
      const internalToken = c.req.header(INTERNAL_AUTH_HEADER);
      if (internalToken) {
        const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
        if (isLoopback(incoming?.socket?.remoteAddress)) {
          const userId = verifyInternalToken(internalToken);
          if (userId) {
            const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
            c.set(
              "user",
              user
                ? { id: user.id, email: user.email, name: user.name, displayName: user.name }
                : null,
            );
            return next();
          }
        }
        // Don't fall through to JWT validation — an internal-auth header
        // that fails verification is a request that should be rejected.
        c.set("user", null);
        return next();
      }

      const authHeader = c.req.header("Authorization");

      if (!authHeader?.startsWith("Bearer ")) {
        c.set("user", null);
        return next();
      }

      const token = authHeader.slice(7);

      // API key path
      if (token.startsWith("sk-")) {
        const user = await resolveApiKey(db, token);
        // X-Sideways-Actor header overrides the actor display name (e.g.
        // CLI --as flag). Restricted to API keys that were created with a
        // stored actorName — i.e. keys explicitly marked as agent keys.
        // This keeps the "agent identity" affordance for the CLI while
        // preventing an arbitrary key holder from spoofing reserved names
        // like "System" in comments and notifications.
        const actorOverride = c.req.header("X-Sideways-Actor");
        if (user && user.actorName && actorOverride) {
          const cleaned = sanitiseActorName(actorOverride);
          if (cleaned) {
            user.actorName = cleaned;
            user.displayName = `${cleaned} via ${user.name}`;
          }
        }
        c.set("user", user);
        return next();
      }

      // JWT path. The general API surface only accepts apiAudience tokens.
      // MCP-audience tokens are rejected here so a connector's JWT cannot
      // bypass /api/mcp and reach the REST API directly; the /api/mcp
      // route runs its own jwtVerify with audience=mcpAudience and then
      // uses internal-auth tokens to invoke /api/* (see internalAuth.ts).
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: env.hydraIssuerUrl,
          audience: env.apiAudience,
        });

        // Custom claims injected at consent
        const ext = (payload as any).ext || {};
        if (ext.user_id) {
          const name = ext.name || "";
          // actor_name is set at consent time for OAuth clients with the
          // mcp scope — the DCR'd client_name becomes the agent identity.
          // Comments and edits get attributed as "Claude via Kezia" etc.
          const actorName = typeof ext.actor_name === "string" && ext.actor_name
            ? sanitiseActorName(ext.actor_name)
            : null;
          c.set("user", {
            id: ext.user_id,
            email: ext.email || "",
            name,
            actorName: actorName || undefined,
            displayName: actorName ? `${actorName} via ${name}` : name,
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

    const actor = apiKey.actorName || undefined;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      actorName: actor,
      displayName: actor ? `${actor} via ${user.name}` : user.name,
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
