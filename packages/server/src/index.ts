import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { createDb } from "@sideways/db";
import { createStorage } from "@sideways/storage";
import { createDocumentRoutes } from "./routes/documents.js";
import { createSpaceRoutes } from "./routes/spaces.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createKeyRoutes } from "./routes/keys.js";
import { authMiddleware } from "./middleware/auth.js";
import { env } from "./env.js";

const db = createDb(env.databaseUrl);
const storage = createStorage({ filerUrl: env.seaweedFilerUrl });

const app = new Hono();

app.use("*", cors());

// Auth middleware on all routes — sets user if token present, null otherwise
app.use("*", authMiddleware(db));

app.get("/health", (c) => c.json({ status: "ok" }));

// Auth flow routes (login, consent, callback) — no auth required
app.route("/auth", createAuthRoutes(db));

// API routes
app.route("/api/spaces", createSpaceRoutes(db));
app.route("/api/documents", createDocumentRoutes(db, storage));
app.route("/api/keys", createKeyRoutes(db));

serve({ fetch: app.fetch, port: env.port }, () => {
  console.log(`Sideways API running on http://localhost:${env.port}`);
});

export default app;
