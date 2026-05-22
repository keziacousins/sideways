/**
 * Internal auth — for in-process callers (MCP server, scheduled jobs)
 * that need to invoke API routes on behalf of a known user without
 * re-presenting the user's JWT.
 *
 * The MCP route validates a Hydra JWT with audience=sideways-mcp, then
 * forwards each tool call via HTTP loopback to /api/*. If we let those
 * JWTs authenticate against /api/* directly, a malicious MCP-scoped
 * token could bypass the MCP layer and reach the REST surface — that
 * was H1 in SECURITY-AUDIT-2.md. The fix is two parts:
 *  1. The auth middleware only honours JWTs with audience=sideways-api.
 *  2. MCP's makeApiFetch issues a per-request internal token (HMAC over
 *     userId + actorName + expiry, signed with a per-process secret)
 *     instead of the user's JWT. The middleware accepts it only when the
 *     request comes from a loopback address.
 *
 * Token shape: `${userId}.${actorB64}.${expiresAt}.${sig}` (4 parts).
 * `actorB64` is the base64url-encoded actor name (empty string when no
 * actor). The actor field was added so DCR'd / OAuth-via-MCP comments
 * can carry the server-set attribution label ("Connector via …" etc.)
 * through the loopback bridge — see issue #43. The HMAC binds
 * userId↔actor↔expiry so the three fields can't be substituted
 * independently; the actor value still originates from the trusted
 * boundary (`actorNameForConsent` at consent time), not from the
 * connector. Loopback-only, 30s TTL, per-process secret unchanged.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

/**
 * Per-process HMAC secret. Regenerated on every server start, so leaked
 * tokens stop working at the next restart. The secret never leaves the
 * process — only signed tokens cross the loopback boundary.
 */
const INTERNAL_SECRET = randomBytes(32);

const INTERNAL_TOKEN_TTL_MS = 30_000; // 30s — long enough for a slow tool call, short enough to make replay impractical
const INTERNAL_HEADER = "x-sideways-internal-auth";

export interface InternalAuthPayload {
  userId: string;
  /** Server-set attribution label (e.g. "Connector", sanitised client_name). */
  actorName: string | null;
}

/**
 * Sign a short-lived internal token authenticating as `userId`, optionally
 * carrying an `actorName` for attribution. The actor is base64url-encoded
 * to avoid collisions with the `.` delimiter; an empty encoding stands for
 * "no actor".
 */
export function signInternalToken(userId: string, actorName?: string | null): string {
  const expiresAt = Date.now() + INTERNAL_TOKEN_TTL_MS;
  const actorB64 = actorName
    ? Buffer.from(actorName, "utf8").toString("base64url")
    : "";
  const payload = `${userId}.${actorB64}.${expiresAt}`;
  const sig = createHmac("sha256", INTERNAL_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify a signed internal token. Returns `{ userId, actorName }` or null.
 * Constant-time signature compare so we don't leak token bytes through timing.
 */
export function verifyInternalToken(token: string): InternalAuthPayload | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, actorB64, expiresAtStr, sig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  const expectedSig = createHmac("sha256", INTERNAL_SECRET)
    .update(`${userId}.${actorB64}.${expiresAtStr}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  const actorName = actorB64
    ? Buffer.from(actorB64, "base64url").toString("utf8")
    : null;
  return { userId, actorName };
}

const LOOPBACK_IPS = new Set<string>([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

/** True when the request originated from the loopback interface. */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return LOOPBACK_IPS.has(remoteAddress);
}

export const INTERNAL_AUTH_HEADER = INTERNAL_HEADER;
