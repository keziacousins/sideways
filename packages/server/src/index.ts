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
import { createThemeRoutes } from "./routes/themes.js";
import { createNotificationRoutes } from "./routes/notifications.js";
import { createSearchRoutes } from "./routes/search.js";
import { createShareRoutes, createInviteRoutes } from "./routes/share.js";
import { authMiddleware } from "./middleware/auth.js";
import { requestLogMiddleware } from "./middleware/requestLog.js";
import { logger } from "./logger.js";
import { env } from "./env.js";

const db = createDb(env.databaseUrl);
const storage = createStorage({ filerUrl: env.seaweedFilerUrl });

const app = new Hono();

app.use("*", cors({
  origin: (origin) => {
    // Allow requests from our own frontend, Tailscale, and localhost dev
    const allowed = [
      env.publicUrl,
      env.publicApiUrl,
      "http://localhost:4000",
      "http://localhost:4100",
    ];
    // Also allow any *.ts.net (Tailscale) origin
    if (origin?.endsWith(".ts.net")) return origin;
    return allowed.includes(origin) ? origin : allowed[0];
  },
  credentials: true,
}));
app.use("*", requestLogMiddleware);

// Auth middleware on all routes — sets user if token present, null otherwise
app.use("*", authMiddleware(db));


const PUBLIC_API_PATHS = [
  "/api/auth/",        // login, register, token exchange
  "/api/mcp",          // MCP handles its own auth via API key
  "/api/invite/",      // invite metadata (GET is public, POST checks auth internally)
];

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  // Allow public paths through
  if (PUBLIC_API_PATHS.some(p => path.startsWith(p))) return next();
  // Allow GET requests for read endpoints (visibility middleware handles access)
  if (c.req.method === "GET") return next();
  // All other API requests require authentication
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const rootPkg = _require("../../../package.json");

app.get("/health", (c) => c.json({ status: "ok", version: rootPkg.version }));

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
app.route("/api/themes", createThemeRoutes(db, storage));
app.route("/api/notifications", createNotificationRoutes(db));
app.route("/api/search", createSearchRoutes(db));
app.route("/api/spaces", createShareRoutes(db));
app.route("/api/invite", createInviteRoutes(db));

// Cleanup expired API keys every hour
import { lt } from "drizzle-orm";
import { apiKeys } from "@sideways/db";
setInterval(async () => {
  try {
    await db.delete(apiKeys).where(lt(apiKeys.expiresAt, new Date()));
    logger.debug("Cleaned up expired API keys");
  } catch (err: any) {
    logger.error({ err: err.message }, "API key cleanup failed");
  }
}, 60 * 60 * 1000);

serve({ fetch: app.fetch, port: env.port }, () => {
  logger.info({ port: env.port }, "Sideways API running");
});

export default app;
