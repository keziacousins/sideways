import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { createDb } from "@sideways/db";
import { createStorage } from "@sideways/storage";
import { createDocumentRoutes } from "./routes/documents.js";
import { createSpaceRoutes } from "./routes/spaces.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createKeyRoutes } from "./routes/keys.js";
import { createCommentRoutes } from "./routes/comments.js";
import { createMcpRoutes } from "./routes/mcp.js";
import { authMiddleware } from "./middleware/auth.js";
import { requestLogMiddleware } from "./middleware/requestLog.js";
import { logger } from "./logger.js";
import { env } from "./env.js";

const db = createDb(env.databaseUrl);
const storage = createStorage({ filerUrl: env.seaweedFilerUrl });

const app = new Hono();

app.use("*", cors());
app.use("*", requestLogMiddleware);

// Auth middleware on all routes — sets user if token present, null otherwise
app.use("*", authMiddleware(db));

app.get("/health", (c) => c.json({ status: "ok" }));

// Hydra public proxy — browser hits localhost, we forward to Hydra.
// Preserves cookies/CSRF because the browser stays on localhost.
// In production, nginx handles this instead.
app.all("/oauth2/*", async (c) => {
  const path = c.req.path;
  const url = new URL(path, env.hydraPublicUrl);
  url.search = new URL(c.req.url).search;

  const headers = new Headers();
  // Forward relevant headers
  for (const key of ["cookie", "content-type", "authorization"]) {
    const val = c.req.header(key);
    if (val) headers.set(key, val);
  }

  const res = await fetch(url.toString(), {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.blob(),
    redirect: "manual",
  });

  // Forward response headers, rewriting Hydra's domain to localhost
  const responseHeaders = new Headers();
  res.headers.forEach((value, key) => {
    // Rewrite Location header to keep browser on localhost
    if (key.toLowerCase() === "location") {
      value = value.replace(env.hydraPublicUrl, `http://localhost:${env.port}`);
    }
    // Rewrite Set-Cookie domain
    if (key.toLowerCase() === "set-cookie") {
      value = value.replace(/domain=[^;]*/gi, "");
    }
    responseHeaders.append(key, value);
  });

  return new Response(res.body, {
    status: res.status,
    headers: responseHeaders,
  });
});

app.get("/.well-known/*", async (c) => {
  const path = c.req.path;
  // Don't proxy MCP OAuth discovery — we use API key auth, not OAuth
  if (path.includes("oauth-protected-resource") || path.includes("oauth-authorization-server")) {
    return c.json({ error: "Not found" }, 404);
  }
  const url = new URL(path, env.hydraPublicUrl);
  const res = await fetch(url.toString());
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") || "application/json" },
  });
});

// API routes
app.route("/api/auth", createAuthRoutes(db));
app.route("/api/spaces", createSpaceRoutes(db));
app.route("/api/documents", createDocumentRoutes(db, storage));
app.route("/api/keys", createKeyRoutes(db));
app.route("/api/comments", createCommentRoutes(db));
app.route("/api/mcp", createMcpRoutes(db));

serve({ fetch: app.fetch, port: env.port }, () => {
  logger.info({ port: env.port }, "Sideways API running");
});

export default app;
