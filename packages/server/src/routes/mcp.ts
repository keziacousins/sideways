/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 * Stateless: each request gets a fresh server + transport (auth via API key).
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools, INSTRUCTIONS } from "@sideways/mcp/tools";
import { logger } from "../logger.js";
import type { Database } from "@sideways/db";

export function createMcpRoutes(db: Database) {
  const router = new Hono();

  function makeApiFetch(apiKey: string) {
    const apiUrl = `http://localhost:${process.env.PORT || 4100}`;
    return async (path: string, options?: RequestInit) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...((options?.headers as Record<string, string>) || {}),
      };
      const res = await fetch(`${apiUrl}${path}`, { ...options, headers });
      if (!res.ok) {
        const body = await res.text();
        logger.error({ path, status: res.status, body }, "MCP apiFetch error");
        throw new Error(`API error ${res.status}: ${body}`);
      }
      return res.json();
    };
  }

  function extractKey(c: any): string | null {
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    const key = c.req.query("key");
    if (key) return key;
    return null;
  }

  router.all("/*", async (c) => {
    const apiKey = extractKey(c);
    if (!apiKey) {
      return c.json({ error: "API key required. Pass as Bearer token or ?key= param." }, 401);
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
    const server = new McpServer({ name: "sideways", version: "0.0.1" }, { instructions: INSTRUCTIONS });
    registerTools(server, makeApiFetch(apiKey));

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
      // @ts-ignore duplex needed for streaming body
      duplex: "half",
    });

    return transport.handleRequest(fixedReq);
  });

  return router;
}
