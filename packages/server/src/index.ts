import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { documents } from "./routes/documents.js";

const app = new Hono();

app.use("*", cors());

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/documents", documents);

const port = Number(process.env.PORT) || 4100;

serve({ fetch: app.fetch, port }, () => {
  console.log(`Sideways API running on http://localhost:${port}`);
});

export default app;
