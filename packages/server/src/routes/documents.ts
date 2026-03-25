import { Hono } from "hono";
import { renderMarkdown } from "@sideways/markdown";
import type { Document } from "@sideways/types";

const documents = new Hono();

/**
 * In-memory store for development. Will be replaced with Postgres.
 */
const docs = new Map<string, Document>();

// Seed a sample document
docs.set("hello-world", {
  id: "1",
  slug: "hello-world",
  title: "Hello World",
  content: `# Hello World

Welcome to **Sideways** — neither markup nor markdown, but something else entirely.

## Features

- Markdown rendering with full GFM support
- Syntax highlighting
- Math: $E = mc^2$
- Diagrams (coming soon)

\`\`\`typescript
const greeting = "Hello from Sideways!";
console.log(greeting);
\`\`\`

## What's Next

This is a seed document. Replace it with your own content via the API.
`,
  visibility: "public",
  ownerId: "system",
  parentId: null,
  position: 0,
  tags: ["welcome"],
  themeId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** List all documents */
documents.get("/", (c) => {
  const all = Array.from(docs.values()).map(({ content: _, ...meta }) => meta);
  return c.json(all);
});

/** Get a document by slug (raw markdown) */
documents.get("/:slug", (c) => {
  const doc = docs.get(c.req.param("slug"));
  if (!doc) return c.json({ error: "Not found" }, 404);
  return c.json(doc);
});

/** Get a document rendered as HTML */
documents.get("/:slug/render", async (c) => {
  const doc = docs.get(c.req.param("slug"));
  if (!doc) return c.json({ error: "Not found" }, 404);

  const target = c.req.query("target") === "pdf" ? "pdf" : "web";
  const html = await renderMarkdown(doc.content, { target });
  return c.json({ ...doc, html, content: undefined });
});

/** Create or update a document */
documents.put("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json<Partial<Document>>();
  const existing = docs.get(slug);

  const doc: Document = {
    id: existing?.id ?? crypto.randomUUID(),
    slug,
    title: body.title ?? slug,
    content: body.content ?? "",
    visibility: body.visibility ?? "private",
    ownerId: body.ownerId ?? "anonymous",
    parentId: body.parentId ?? null,
    position: body.position ?? 0,
    tags: body.tags ?? [],
    themeId: body.themeId ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  docs.set(slug, doc);
  return c.json(doc, existing ? 200 : 201);
});

/** Delete a document */
documents.delete("/:slug", (c) => {
  const slug = c.req.param("slug");
  if (!docs.has(slug)) return c.json({ error: "Not found" }, 404);
  docs.delete(slug);
  return c.json({ deleted: true });
});

export { documents };
