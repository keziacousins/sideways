#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.SIDEWAYS_API_URL || "http://localhost:4100";
const API_KEY = process.env.SIDEWAYS_API_KEY || "";

async function apiFetch(path: string, options?: RequestInit) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options?.headers as Record<string, string>) || {}),
  };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "sideways",
  version: "0.0.1",
});

// ── list_spaces ─────────────────────────────────────────────────────

server.tool(
  "list_spaces",
  "List all documentation spaces the user has access to",
  {},
  async () => {
    const spaces = await apiFetch("/api/spaces");
    const text = spaces
      .map((s: any) => `${s.slug}: ${s.name} (${s.visibility})${s.description ? ` — ${s.description}` : ""}`)
      .join("\n");
    return { content: [{ type: "text", text: text || "No spaces found." }] };
  },
);

// ── list_docs ───────────────────────────────────────────────────────

server.tool(
  "list_docs",
  "List documents in a space",
  {
    space: z.string().describe("Space slug"),
  },
  async ({ space }) => {
    const docs = await apiFetch(`/api/documents?space=${space}`);
    const text = docs
      .map((d: any) => {
        const tags = d.tags?.length ? ` [${d.tags.join(", ")}]` : "";
        return `${d.slug}: ${d.title}${tags}`;
      })
      .join("\n");
    return { content: [{ type: "text", text: text || "No documents in this space." }] };
  },
);

// ── read_doc ────────────────────────────────────────────────────────

server.tool(
  "read_doc",
  "Read a document's markdown content, optionally with comments embedded",
  {
    space: z.string().describe("Space slug"),
    slug: z.string().describe("Document slug"),
    include_comments: z.boolean().optional().describe("Include comments as HTML comment blocks in the markdown (default: true)"),
  },
  async ({ space, slug, include_comments }) => {
    const doc = await apiFetch(`/api/documents/${space}/${slug}`);
    let content = doc.content;

    if (include_comments !== false) {
      try {
        const comments = await apiFetch(`/api/comments/${space}/${slug}`);
        if (comments.length > 0) {
          // Import dynamically to avoid bundling issues
          const lines: string[] = [];
          for (const c of comments) {
            const author = c.author?.name || "Unknown";
            const date = c.createdAt?.slice(0, 10) || "";
            const section = c.anchorSection ? ` section="${c.anchorSection}"` : "";
            const anchor = c.anchorText ? ` anchor="${c.anchorText}"` : "";
            const parent = c.parentId ? ` parent="${c.parentId}"` : "";
            lines.push(`<!-- @comment id="${c.id}" author="${author}" date="${date}"${section}${anchor}${parent}\n${c.body}\n-->`);
          }
          content = content + "\n\n" + lines.join("\n\n");
        }
      } catch {}
    }

    const meta = `Space: ${space} | Slug: ${slug} | Title: ${doc.title}`;
    return {
      content: [{ type: "text", text: `${meta}\n---\n${content}` }],
    };
  },
);

// ── write_doc ───────────────────────────────────────────────────────

server.tool(
  "write_doc",
  "Create or update a document. Content should be markdown. Title is auto-extracted from the first # heading if not provided.",
  {
    space: z.string().describe("Space slug"),
    slug: z.string().describe("Document slug"),
    content: z.string().describe("Markdown content"),
    title: z.string().optional().describe("Document title (auto-extracted from # heading if omitted)"),
    tags: z.array(z.string()).optional().describe("Document tags"),
  },
  async ({ space, slug, content, title, tags }) => {
    const body: Record<string, any> = { content };
    if (title) body.title = title;
    if (tags) body.tags = tags;

    const doc = await apiFetch(`/api/documents/${space}/${slug}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });

    return {
      content: [{ type: "text", text: `Saved ${space}/${slug} (${doc.title})` }],
    };
  },
);

// ── add_comment ─────────────────────────────────────────────────────

server.tool(
  "add_comment",
  "Add a comment to a document. Can be a page-level comment or anchored to specific text.",
  {
    space: z.string().describe("Space slug"),
    slug: z.string().describe("Document slug"),
    body: z.string().describe("Comment text"),
    anchor_text: z.string().optional().describe("Text in the document to anchor this comment to"),
    anchor_section: z.string().optional().describe("Section heading path (e.g. 'Installation > Prerequisites')"),
    parent_id: z.string().optional().describe("Parent comment ID for threaded replies"),
  },
  async ({ space, slug, body, anchor_text, anchor_section, parent_id }) => {
    const payload: Record<string, any> = { body };
    if (anchor_text) payload.anchorText = anchor_text;
    if (anchor_section) payload.anchorSection = anchor_section;
    if (parent_id) payload.parentId = parent_id;

    const comment = await apiFetch(`/api/comments/${space}/${slug}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    return {
      content: [{ type: "text", text: `Comment added (${comment.id})` }],
    };
  },
);

// ── list_comments ───────────────────────────────────────────────────

server.tool(
  "list_comments",
  "List comments on a document",
  {
    space: z.string().describe("Space slug"),
    slug: z.string().describe("Document slug"),
    include_resolved: z.boolean().optional().describe("Include resolved comments (default: false)"),
  },
  async ({ space, slug, include_resolved }) => {
    const qs = include_resolved ? "?include_resolved=true" : "";
    const comments = await apiFetch(`/api/comments/${space}/${slug}${qs}`);

    if (comments.length === 0) {
      return { content: [{ type: "text", text: "No comments on this document." }] };
    }

    const text = comments
      .map((c: any) => {
        const author = c.author?.name || "Unknown";
        const anchor = c.anchorText ? `\n  Anchor: "${c.anchorText.slice(0, 80)}"` : "";
        const section = c.anchorSection ? `\n  Section: ${c.anchorSection}` : "";
        const parent = c.parentId ? ` (reply)` : "";
        const resolved = c.resolved ? " [RESOLVED]" : "";
        return `[${c.id.slice(0, 8)}] ${author}${parent}${resolved}${section}${anchor}\n  ${c.body}`;
      })
      .join("\n\n");

    return { content: [{ type: "text", text }] };
  },
);

// ── resolve_comment ─────────────────────────────────────────────────

server.tool(
  "resolve_comment",
  "Resolve or reopen a comment thread",
  {
    space: z.string().describe("Space slug"),
    slug: z.string().describe("Document slug"),
    comment_id: z.string().describe("Comment ID to resolve/reopen"),
  },
  async ({ space, slug, comment_id }) => {
    const comment = await apiFetch(`/api/comments/${space}/${slug}/${comment_id}/resolve`, {
      method: "POST",
    });

    return {
      content: [{ type: "text", text: `Comment ${comment.resolved ? "resolved" : "reopened"}` }],
    };
  },
);

// ── search_docs ─────────────────────────────────────────────────────

server.tool(
  "search_docs",
  "Search for documents by title across all accessible spaces",
  {
    query: z.string().describe("Search query (matches document titles)"),
  },
  async ({ query }) => {
    // Simple title search across all spaces
    const spaces = await apiFetch("/api/spaces");
    const results: string[] = [];
    const q = query.toLowerCase();

    for (const s of spaces) {
      const docs = await apiFetch(`/api/documents?space=${s.slug}`);
      for (const d of docs) {
        if (d.title.toLowerCase().includes(q) || d.slug.includes(q)) {
          results.push(`${s.slug}/${d.slug}: ${d.title}`);
        }
      }
    }

    return {
      content: [{ type: "text", text: results.length ? results.join("\n") : "No documents found." }],
    };
  },
);

// ── delete_doc ──────────────────────────────────────────────────────

server.tool(
  "delete_doc",
  "Delete a document",
  {
    space: z.string().describe("Space slug"),
    slug: z.string().describe("Document slug"),
  },
  async ({ space, slug }) => {
    await apiFetch(`/api/documents/${space}/${slug}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Deleted ${space}/${slug}` }] };
  },
);

// ── doc_versions ────────────────────────────────────────────────────

server.tool(
  "doc_versions",
  "List version history of a document",
  {
    space: z.string().describe("Space slug"),
    slug: z.string().describe("Document slug"),
  },
  async ({ space, slug }) => {
    const versions = await apiFetch(`/api/documents/${space}/${slug}/versions`);
    const text = versions
      .map((v: any) => `v${v.version} — ${v.contentHash} — ${new Date(v.createdAt).toLocaleString()}`)
      .join("\n");
    return { content: [{ type: "text", text: text || "No versions." }] };
  },
);

// ── Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
