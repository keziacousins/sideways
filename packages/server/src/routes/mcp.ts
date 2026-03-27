/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 * Allows Claude Desktop and other MCP clients to connect via SSE.
 *
 * Auth: API key passed as Bearer token or ?key= query param.
 * Sessions are tracked in-memory. If a session expires (server restart),
 * stale requests are handled by creating a new session transparently.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools, INSTRUCTIONS } from "@sideways/mcp/tools";
import { logger } from "../logger.js";
import type { Database } from "@sideways/db";

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  apiKey: string;
  createdAt: number;
}

export function createMcpRoutes(db: Database) {
  const router = new Hono();
  const sessions = new Map<string, McpSession>();

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

  function createSession(apiKey: string): McpSession {
    const server = new McpServer({ name: "sideways", version: "0.0.1" }, { instructions: INSTRUCTIONS });
    registerTools(server, makeApiFetch(apiKey));

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        logger.info({ sessionId: id }, "MCP session created");
        sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        logger.info({ sessionId: id }, "MCP session closed");
        sessions.delete(id);
      },
    });

    server.server.onerror = (err) => {
      logger.error({ err: err.message, stack: err.stack }, "MCP server error");
    };

    const session: McpSession = { transport, server, apiKey, createdAt: Date.now() };
    return session;
  }

  router.all("/*", async (c) => {
    const apiKey = extractKey(c);
    if (!apiKey) {
      return c.json({ error: "API key required. Pass as Bearer token or ?key= param." }, 401);
    }

    const method = c.req.method;
    const sessionId = c.req.header("mcp-session-id");

    logger.debug({ method, sessionId: sessionId?.slice(0, 8), activeSessions: sessions.size }, "MCP request");

    if (method === "DELETE") {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.close();
        sessions.delete(sessionId);
      }
      return new Response(null, { status: 204 });
    }

    if (method !== "GET" && method !== "POST") {
      return c.json({ error: "Method not allowed" }, 405);
    }

    // Route to existing session if valid
    if (sessionId && sessions.has(sessionId)) {
      return sessions.get(sessionId)!.transport.handleRequest(c.req.raw);
    }

    // No valid session — create a new one and initialize it.
    // For POST with stale session: the client sent a tools/call but the session
    // is gone. We can't just forward it — we need to initialize first.
    // Return 409 so the client knows to re-initialize.
    if (method === "POST" && sessionId) {
      logger.info({ sessionId: sessionId.slice(0, 8) }, "MCP stale session, requesting re-init");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session expired" }, id: null }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    // New session: POST without session ID (initialize) or GET (SSE stream)
    const session = createSession(apiKey);
    await session.server.connect(session.transport);
    return session.transport.handleRequest(c.req.raw);
  });

  // Clean up old sessions every 10 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.createdAt > 30 * 60 * 1000) { // 30 min TTL
        session.transport.close().catch(() => {});
        sessions.delete(id);
        logger.debug({ sessionId: id.slice(0, 8) }, "MCP session expired (TTL)");
      }
    }
  }, 10 * 60 * 1000);

  return router;
}
