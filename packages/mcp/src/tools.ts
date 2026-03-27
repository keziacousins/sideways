/**
 * MCP tool registrations — shared between stdio and SSE transports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type ApiFetch = (path: string, options?: RequestInit) => Promise<any>;

export function registerTools(server: McpServer, apiFetch: ApiFetch) {
  server.tool(
    "list_spaces",
    "List all documentation spaces the user has access to",
    {},
    async () => {
      const spaces = await apiFetch("/api/spaces");
      const text = spaces
        .map((s: any) => `${s.slug}: ${s.name} (${s.visibility})${s.description ? ` — ${s.description}` : ""}`)
        .join("\n");
      return { content: [{ type: "text" as const, text: text || "No spaces found." }] };
    },
  );

  server.tool(
    "list_docs",
    "List documents in a space",
    { space: z.string().describe("Space slug") },
    async ({ space }) => {
      const docs = await apiFetch(`/api/documents?space=${space}`);
      const text = docs
        .map((d: any) => {
          const tags = d.tags?.length ? ` [${d.tags.join(", ")}]` : "";
          return `${d.slug}: ${d.title}${tags}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text: text || "No documents in this space." }] };
    },
  );

  server.tool(
    "read_doc",
    "Read a document's markdown content, optionally with comments embedded",
    {
      space: z.string().describe("Space slug"),
      slug: z.string().describe("Document slug"),
      include_comments: z.boolean().optional().describe("Include comments as HTML comment blocks (default: true)"),
    },
    async ({ space, slug, include_comments }) => {
      const doc = await apiFetch(`/api/documents/${space}/${slug}`);
      let content = doc.content;

      if (include_comments !== false) {
        try {
          const comments = await apiFetch(`/api/comments/${space}/${slug}`);
          if (comments.length > 0) {
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
      return { content: [{ type: "text" as const, text: `${meta}\n---\n${content}` }] };
    },
  );

  server.tool(
    "write_doc",
    "Create or update a document. Content should be markdown.",
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

      return { content: [{ type: "text" as const, text: `Saved ${space}/${slug} (${doc.title})` }] };
    },
  );

  server.tool(
    "add_comment",
    "Add a comment to a document, optionally anchored to specific text",
    {
      space: z.string().describe("Space slug"),
      slug: z.string().describe("Document slug"),
      body: z.string().describe("Comment text"),
      anchor_text: z.string().optional().describe("Text to anchor this comment to"),
      anchor_section: z.string().optional().describe("Section heading path"),
      parent_id: z.string().optional().describe("Parent comment ID for replies"),
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

      return { content: [{ type: "text" as const, text: `Comment added (${comment.id})` }] };
    },
  );

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
        return { content: [{ type: "text" as const, text: "No comments on this document." }] };
      }

      const text = comments
        .map((c: any) => {
          const author = c.author?.name || "Unknown";
          const anchor = c.anchorText ? `\n  Anchor: "${c.anchorText.slice(0, 80)}"` : "";
          const section = c.anchorSection ? `\n  Section: ${c.anchorSection}` : "";
          const parent = c.parentId ? ` (reply)` : "";
          const resolved = c.resolved ? " [RESOLVED]" : "";
          return `[${c.id}] ${author}${parent}${resolved}${section}${anchor}\n  ${c.body}`;
        })
        .join("\n\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "resolve_comment",
    "Resolve or reopen a comment thread",
    {
      space: z.string().describe("Space slug"),
      slug: z.string().describe("Document slug"),
      comment_id: z.string().describe("Comment ID"),
    },
    async ({ space, slug, comment_id }) => {
      const comment = await apiFetch(`/api/comments/${space}/${slug}/${comment_id}/resolve`, {
        method: "POST",
      });
      return { content: [{ type: "text" as const, text: `Comment ${comment.resolved ? "resolved" : "reopened"}` }] };
    },
  );

  server.tool(
    "search_docs",
    "Search for documents by title across all spaces",
    { query: z.string().describe("Search query") },
    async ({ query }) => {
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

      return { content: [{ type: "text" as const, text: results.length ? results.join("\n") : "No documents found." }] };
    },
  );

  server.tool(
    "delete_doc",
    "Delete a document",
    {
      space: z.string().describe("Space slug"),
      slug: z.string().describe("Document slug"),
    },
    async ({ space, slug }) => {
      await apiFetch(`/api/documents/${space}/${slug}`, { method: "DELETE" });
      return { content: [{ type: "text" as const, text: `Deleted ${space}/${slug}` }] };
    },
  );

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
      return { content: [{ type: "text" as const, text: text || "No versions." }] };
    },
  );
}
