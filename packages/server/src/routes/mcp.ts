/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 *
 * Stateless: each request gets a fresh server + transport. Two auth paths
 * coexist — programmatic callers (CLI etc) use `Authorization: Bearer sk-…`,
 * and OAuth clients (claude.ai's connector flow) use a Hydra-issued JWT
 * with audience `sideways-mcp`. The OAuth flow is bootstrapped via the
 * RFC 9728 protected-resource-metadata endpoint below.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { jwtVerify } from "jose";
import { registerTools, INSTRUCTIONS } from "@sideways/mcp/tools";
import { JWKS } from "../middleware/auth.js";
import { INTERNAL_AUTH_HEADER, signInternalToken } from "../middleware/internalAuth.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { Database } from "@sideways/db";
import pkg from "../../package.json" with { type: "json" };

export function createMcpRoutes(_db: Database) {
  const router = new Hono();

  const mcpResourceUrl = `${env.publicApiUrl}/api/mcp`;
  const resourceMetadataUrl = `${mcpResourceUrl}/.well-known/oauth-protected-resource`;

  // RFC 9728 — protected resource metadata. claude.ai (and other compliant
  // MCP clients) fetch this after a 401 to learn which authorization
  // server to use. authorization_servers[0] is the only entry inspected.
  router.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: mcpResourceUrl,
      authorization_servers: [env.hydraIssuerUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    }),
  );

  /**
   * Build the apiFetch closure used by MCP tools. Two auth shapes:
   *  - API-key token (sk-…): forwarded through as Bearer; the loopback
   *    request hits the auth middleware which validates the key as usual
   *    (and applies the key's stored actor_name, if any).
   *  - JWT user (with userId + optional actorName from a successfully
   *    validated MCP-audience token): an internal-auth token is signed
   *    for that userId + actorName and sent instead of the JWT. The
   *    middleware accepts it on loopback only, so MCP-audience JWTs
   *    cannot reach /api/* directly from the network, and the actor
   *    label set at consent time (`actorNameForConsent`) flows through
   *    to the comment row.
   */
  function makeApiFetch(
    auth:
      | { kind: "apikey"; token: string }
      | { kind: "jwt"; userId: string; actorName: string | null },
  ) {
    const apiUrl = `http://localhost:${env.port}`;
    return async (path: string, options?: RequestInit) => {
      const baseHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...((options?.headers as Record<string, string>) || {}),
      };
      if (auth.kind === "apikey") {
        baseHeaders["Authorization"] = `Bearer ${auth.token}`;
      } else {
        baseHeaders[INTERNAL_AUTH_HEADER] = signInternalToken(auth.userId, auth.actorName);
      }
      const res = await fetch(`${apiUrl}${path}`, { ...options, headers: baseHeaders });
      if (!res.ok) {
        const body = await res.text();
        logger.error({ path, status: res.status, body }, "MCP apiFetch error");
        throw new Error(`API error ${res.status}: ${body}`);
      }
      return res.json();
    };
  }

  // 401 builder shared between the no-auth and bad-JWT paths. Per
  // Anthropic's connector auth docs the `scope=` attribute is
  // authoritative for the scope set claude.ai will request; the
  // resource_metadata attribute points clients at the PRM document.
  function unauthorized(c: any, error: string) {
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl}", ` +
        `scope="mcp offline_access", error="${error}"`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  router.all("/*", async (c) => {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return unauthorized(c, "invalid_token");
    const token = auth.slice(7);

    // Branch the auth used by makeApiFetch downstream.
    let fetchAuth:
      | { kind: "apikey"; token: string }
      | { kind: "jwt"; userId: string; actorName: string | null };
    if (token.startsWith("sk-")) {
      // API keys: the loopback request will re-validate via authMiddleware
      // (which applies the key's stored actor_name from the DB).
      fetchAuth = { kind: "apikey", token };
    } else {
      // JWTs: verify here (audience=sideways-mcp) and surface a proper
      // 401 + WWW-Authenticate on failure. Downstream calls use a signed
      // internal-auth token so the MCP JWT never reaches /api/*. We carry
      // `ext.actor_name` through so the attribution label set at consent
      // time (`actorNameForConsent` — "Connector" for DCR'd clients,
      // sanitised client_name for statically registered) reaches the
      // comment row. See issue #43.
      let userId: string;
      let actorName: string | null = null;
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: env.hydraIssuerUrl,
          audience: env.mcpAudience,
        });
        const ext = (payload as any).ext || {};
        userId = ext.user_id;
        if (!userId) {
          logger.debug("MCP JWT missing ext.user_id");
          return unauthorized(c, "invalid_token");
        }
        if (typeof ext.actor_name === "string" && ext.actor_name) {
          actorName = ext.actor_name;
        }
      } catch (err: any) {
        logger.debug({ err: err.message }, "MCP JWT verification failed");
        return unauthorized(c, "invalid_token");
      }
      fetchAuth = { kind: "jwt", userId, actorName };
    }

    const method = c.req.method;
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (method !== "GET" && method !== "POST") {
      return c.json({ error: "Method not allowed" }, 405);
    }

    logger.debug({ method }, "MCP request");

    // Stateless: fresh server + transport per request, no session tracking
    const server = new McpServer({ name: "sideways", version: pkg.version }, { instructions: INSTRUCTIONS });
    registerTools(server, makeApiFetch(fetchAuth));

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode — no session validation
    });

    server.server.onerror = (err) => {
      logger.error({ err: err.message, stack: err.stack }, "MCP server error");
    };

    await server.connect(transport);

    // Ensure Accept header includes both required types — some proxies strip it
    const fixedHeaders = new Headers(c.req.raw.headers);
    const accept = fixedHeaders.get("accept") || "";
    if (!accept.includes("text/event-stream")) {
      fixedHeaders.set("accept", "application/json, text/event-stream");
    }
    const fixedReq = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: fixedHeaders,
      body: c.req.raw.body,
      // @ts-expect-error duplex needed for streaming body
      duplex: "half",
    });

    return transport.handleRequest(fixedReq);
  });

  return router;
}
