import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { createDb } from "@sideways/db";
import { createStorage } from "@sideways/storage";
import { createDocumentRoutes } from "./routes/documents.js";
import { createSpaceRoutes } from "./routes/spaces.js";
import { env } from "./env.js";

const db = createDb(env.databaseUrl);
const storage = createStorage({ filerUrl: env.seaweedFilerUrl });

const app = new Hono();

app.use("*", cors());

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/spaces", createSpaceRoutes(db));
app.route("/api/documents", createDocumentRoutes(db, storage));

serve({ fetch: app.fetch, port: env.port }, () => {
  console.log(`Sideways API running on http://localhost:${env.port}`);
});

export default app;
