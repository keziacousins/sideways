/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 * Allows Claude Desktop and other MCP clients to connect via SSE.
 *
 * Auth: API key passed as Bearer token or ?key= query param.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "@sideways/mcp/tools";
import type { Database } from "@sideways/db";

export function createMcpRoutes(db: Database) {
  const router = new Hono();

  // Map of session ID -> transport for active sessions
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  /** Create an authenticated apiFetch for a given user's API key */
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
        throw new Error(`API error ${res.status}: ${body}`);
      }
      return res.json();
    };
  }

  /** Extract API key from request — Bearer token or ?key= param */
  function extractKey(c: any): string | null {
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    const key = c.req.query("key");
    if (key) return key;
    return null;
  }

  // Handle all MCP requests (GET for SSE stream, POST for messages, DELETE for session close)
  router.all("/*", async (c) => {
    const apiKey = extractKey(c);
    if (!apiKey) {
      return c.json({ error: "API key required. Pass as Bearer token or ?key= param." }, 401);
    }

    const sessionId = c.req.header("mcp-session-id");

    if (c.req.method === "GET") {
      // New SSE connection or reconnect
      const server = new McpServer({ name: "sideways", version: "0.0.1" });
      registerTools(server, makeApiFetch(apiKey));

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });

      await server.connect(transport);
      return transport.handleRequest(c.req.raw);
    }

    if (c.req.method === "POST") {
      // If we have a session ID, route to existing transport
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        return transport.handleRequest(c.req.raw);
      }

      // New session — create server + transport
      const server = new McpServer({ name: "sideways", version: "0.0.1" });
      registerTools(server, makeApiFetch(apiKey));

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });

      await server.connect(transport);
      return transport.handleRequest(c.req.raw);
    }

    if (c.req.method === "DELETE" && sessionId) {
      const transport = sessions.get(sessionId);
      if (transport) {
        await transport.close();
        sessions.delete(sessionId);
        return new Response(null, { status: 204 });
      }
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json({ error: "Method not allowed" }, 405);
  });

  return router;
}
