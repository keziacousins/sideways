/**
 * RFC 7591 Dynamic Client Registration wrapper.
 *
 * nginx routes /oauth2/register to this endpoint instead of Hydra directly
 * (see infra/nginx.conf). We validate the incoming registration against a
 * tight policy, then forward to Hydra's admin API to actually create the
 * client. This:
 *  - Restricts redirect_uris to public HTTPS (or http://localhost when the
 *    DCR_ALLOW_LOCALHOST env flag is set, for testing).
 *  - Forces a minimal grant/response/auth-method set — no client_credentials,
 *    no implicit, no PKCE bypass.
 *  - Locks the audience to MCP only. A DCR'd client cannot mint tokens that
 *    authenticate against the REST API surface (which gates on apiAudience).
 *  - Limits scopes to those we understand (`openid offline_access mcp`).
 *  - Sanitises client_name and tags the client with `metadata.dcr = true`
 *    so the consent UI can flag it as a third-party, unverified caller.
 */

import { Hono } from "hono";
import { env } from "../env.js";
import { sanitiseClientName } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { logger } from "../logger.js";

const ALLOWED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const ALLOWED_RESPONSE_TYPES = new Set(["code"]);
const ALLOWED_AUTH_METHODS = new Set(["none", "client_secret_basic", "client_secret_post"]);
const ALLOWED_SCOPES = new Set(["openid", "offline_access", "mcp"]);
const MAX_CLIENT_NAME_LENGTH = 80;
const MAX_REDIRECT_URIS = 8;

/**
 * Reject hostnames that point at private/loopback/link-local addresses.
 * The redirect target is dereferenced by the browser, not by the server,
 * so SSRF isn't the direct risk — the risk is using "localhost" in a
 * phishing flow (e.g. the attacker's machine relays the auth code). The
 * env flag opens this up for dev.
 */
function isPrivateOrLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "localhost.localdomain" || h.endsWith(".localhost")) return true;
  // IPv4 literals
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local incl. cloud metadata
  if (h === "0.0.0.0") return true;
  // IPv6 literals — both naked and bracketed
  const stripped = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (stripped === "::1") return true;
  if (stripped.startsWith("fc") || stripped.startsWith("fd")) return true; // ULA
  if (stripped.startsWith("fe80:")) return true; // link-local
  return false;
}

function validateRedirectUri(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return "redirect_uris contains a malformed URL";
  }
  if (parsed.username || parsed.password) return "redirect_uris cannot contain userinfo";
  if (parsed.hash) return "redirect_uris cannot contain a fragment";

  if (parsed.protocol === "https:") {
    if (isPrivateOrLocalHost(parsed.hostname)) {
      return "redirect_uris cannot point at private or loopback addresses";
    }
    return null;
  }
  if (parsed.protocol === "http:" && env.dcrAllowLocalhost) {
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1") {
      return null;
    }
    return "http:// redirect_uris are only allowed for localhost (dev flag)";
  }
  return "redirect_uris must use https://";
}

interface DcrRequest {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  // We deliberately ignore anything else the caller sends — see the
  // forwarded body construction below.
}

export function createDcrRoutes() {
  const router = new Hono();

  // Rate limit: DCR is unauthenticated. nginx adds its own zone for
  // belt-and-braces, but the Hono limiter is the source of truth for the
  // per-process state and works in dev where nginx isn't in the path.
  router.use("/register", rateLimit({ windowMs: 60_000, max: 10 }));

  router.post("/register", async (c) => {
    let body: DcrRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
    }

    // redirect_uris
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris required" }, 400);
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      return c.json({ error: "invalid_redirect_uri", error_description: `redirect_uris exceeds max of ${MAX_REDIRECT_URIS}` }, 400);
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string") {
        return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris entries must be strings" }, 400);
      }
      const err = validateRedirectUri(uri);
      if (err) {
        return c.json({ error: "invalid_redirect_uri", error_description: err }, 400);
      }
    }

    // client_name
    let clientName = "Connector";
    if (body.client_name !== undefined) {
      if (typeof body.client_name !== "string") {
        return c.json({ error: "invalid_client_metadata", error_description: "client_name must be a string" }, 400);
      }
      if (body.client_name.length > MAX_CLIENT_NAME_LENGTH) {
        return c.json({ error: "invalid_client_metadata", error_description: `client_name exceeds ${MAX_CLIENT_NAME_LENGTH} chars` }, 400);
      }
      const sanitised = sanitiseClientName(body.client_name, MAX_CLIENT_NAME_LENGTH);
      if (!sanitised) {
        return c.json({ error: "invalid_client_metadata", error_description: "client_name is empty after normalisation" }, 400);
      }
      clientName = sanitised;
    }

    // grant_types — force the set we allow
    if (body.grant_types !== undefined) {
      if (!Array.isArray(body.grant_types)) {
        return c.json({ error: "invalid_client_metadata", error_description: "grant_types must be an array" }, 400);
      }
      for (const g of body.grant_types) {
        if (!ALLOWED_GRANT_TYPES.has(g)) {
          return c.json({ error: "invalid_client_metadata", error_description: `grant_types includes unsupported value: ${g}` }, 400);
        }
      }
    }

    // response_types
    if (body.response_types !== undefined) {
      if (!Array.isArray(body.response_types)) {
        return c.json({ error: "invalid_client_metadata", error_description: "response_types must be an array" }, 400);
      }
      for (const r of body.response_types) {
        if (!ALLOWED_RESPONSE_TYPES.has(r)) {
          return c.json({ error: "invalid_client_metadata", error_description: `response_types includes unsupported value: ${r}` }, 400);
        }
      }
    }

    // token_endpoint_auth_method
    const authMethod = body.token_endpoint_auth_method ?? "none";
    if (!ALLOWED_AUTH_METHODS.has(authMethod)) {
      return c.json({ error: "invalid_client_metadata", error_description: `token_endpoint_auth_method must be one of: ${[...ALLOWED_AUTH_METHODS].join(", ")}` }, 400);
    }

    // scope — must be a subset of what we know about
    let scope = "openid offline_access mcp";
    if (body.scope !== undefined) {
      if (typeof body.scope !== "string") {
        return c.json({ error: "invalid_client_metadata", error_description: "scope must be a string" }, 400);
      }
      const tokens = body.scope.split(/\s+/).filter(Boolean);
      for (const t of tokens) {
        if (!ALLOWED_SCOPES.has(t)) {
          return c.json({ error: "invalid_scope", error_description: `scope includes unsupported value: ${t}` }, 400);
        }
      }
      scope = tokens.join(" ");
    }

    // Build the Hydra admin payload. We override everything potentially
    // sensitive — grants, response types, audience, scopes, metadata.
    const hydraPayload = {
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
      scope,
      audience: [env.mcpAudience],
      metadata: {
        dcr: true,
        registered_at: new Date().toISOString(),
      },
    };

    try {
      const res = await fetch(`${env.hydraAdminUrl}/admin/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hydraPayload),
      });
      const created = await res.json();
      if (!res.ok) {
        logger.error({ status: res.status, body: created }, "DCR forward to Hydra failed");
        return c.json(
          { error: created.error || "server_error", error_description: created.error_description || "Could not register client" },
          res.status as any,
        );
      }
      logger.info({ client_id: created.client_id, client_name: clientName }, "DCR client registered");
      return c.json(created, 201);
    } catch (err: any) {
      logger.error({ err: err.message }, "DCR forward error");
      return c.json({ error: "server_error", error_description: "Could not reach the authorization server" }, 502);
    }
  });

  return router;
}
