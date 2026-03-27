/**
 * MCP tool registrations — shared between stdio and SSE transports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type ApiFetch = (path: string, options?: RequestInit) => Promise<any>;

const INSTRUCTIONS = `Sideways is a documentation sharing platform. The data model is:

- **Spaces**: Top-level containers (like projects or teams). Each has a slug, name, visibility (public/private/shared/org), and an owner.
- **Sections**: Optional groupings within a space for organizing documents in the sidebar.
- **Documents**: Versioned markdown files within a space, optionally assigned to a section. Each has a slug (URL-friendly identifier), title, content (markdown), and optional tags.
- **Comments**: Threaded discussions on documents, optionally anchored to specific text.

Common workflows:
- To create documentation for a new project: create_space → write_doc (repeating for each document)
- To review a document: read_doc → add_comment (with anchor_text to reference specific passages)
- To reorganize: rename_doc, move_doc, or reorder_docs
- Slugs are URL-friendly identifiers (lowercase, hyphens). Example: "API Design Guide" → "api-design-guide"
- write_doc is an upsert: it creates the doc if it doesn't exist, or updates it if it does.`;

export function registerTools(server: McpServer, apiFetch: ApiFetch) {
  // --- Spaces ---

  server.tool(
    "list_spaces",
    "List all documentation spaces the user has access to. Returns slug, name, visibility, and description for each space.",
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
    "create_space",
    'Create a new documentation space. Example: create_space("my-project", "My Project", "private"). Visibility options: "public" (anyone can view), "private" (owner + members only), "shared" (anyone with the link), "org" (authenticated users).',
    {
      slug: z.string().describe('URL-friendly identifier, e.g. "engineering-docs"'),
      name: z.string().describe('Display name, e.g. "Engineering Docs"'),
      description: z.string().optional().describe("Short description of the space's purpose"),
      visibility: z.enum(["public", "private", "shared", "org"]).optional().describe("Access level (default: private)"),
    },
    async ({ slug, name, description, visibility }) => {
      const body: Record<string, any> = { name };
      if (description) body.description = description;
      if (visibility) body.visibility = visibility;

      const space = await apiFetch(`/api/spaces/${slug}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      return { content: [{ type: "text" as const, text: `Created space "${space.name}" (${space.slug}, ${space.visibility})` }] };
    },
  );

  // --- Documents ---

  server.tool(
    "list_docs",
    'List all documents in a space. Returns slug, title, and tags for each document. Example: list_docs("engineering")',
    { space: z.string().describe('Space slug, e.g. "engineering"') },
    async ({ space }) => {
      const docs = await apiFetch(`/api/documents?space=${space}`);
      const text = docs
        .map((d: any) => {
          const tags = d.tags?.length ? ` [${d.tags.join(", ")}]` : "";
          const section = d.sectionSlug ? ` (section: ${d.sectionSlug})` : "";
          return `${d.slug}: ${d.title}${tags}${section}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text: text || "No documents in this space." }] };
    },
  );

  server.tool(
    "read_doc",
    'Read a document\'s full markdown content. Optionally includes comments embedded as HTML comment blocks. Example: read_doc("engineering", "api-design")',
    {
      space: z.string().describe('Space slug, e.g. "engineering"'),
      slug: z.string().describe('Document slug, e.g. "api-design"'),
      include_comments: z.boolean().optional().describe("Embed comments as <!-- @comment --> blocks at the end (default: true)"),
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
    'Create or update a document (upsert). If the document exists, creates a new version. If it doesn\'t exist, creates it. The title is auto-extracted from the first # heading if not provided. Example: write_doc("engineering", "api-design", "# API Design Guide\\n\\nOur API follows REST conventions...")',
    {
      space: z.string().describe('Space slug, e.g. "engineering"'),
      slug: z.string().describe('Document slug, e.g. "api-design". Will be created if it doesn\'t exist.'),
      content: z.string().describe("Full markdown content of the document"),
      title: z.string().optional().describe("Document title (auto-extracted from first # heading if omitted)"),
      tags: z.array(z.string()).optional().describe('Tags for categorization, e.g. ["api", "architecture"]'),
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
    "rename_doc",
    'Rename a document\'s title and/or slug without changing its content. Example: rename_doc("engineering", "old-slug", title="New Title", new_slug="new-slug")',
    {
      space: z.string().describe("Space slug"),
      slug: z.string().describe("Current document slug"),
      title: z.string().optional().describe("New title"),
      new_slug: z.string().optional().describe("New URL-friendly slug"),
    },
    async ({ space, slug, title, new_slug }) => {
      const body: Record<string, any> = {};
      if (title) body.title = title;
      if (new_slug) body.slug = new_slug;

      const doc = await apiFetch(`/api/documents/${space}/${slug}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

      return { content: [{ type: "text" as const, text: `Renamed to "${doc.title}" (${doc.slug})` }] };
    },
  );

  server.tool(
    "move_doc",
    'Move a document to a different space or section. Example: move_doc("engineering", "api-design", target_space="platform")',
    {
      space: z.string().describe("Current space slug"),
      slug: z.string().describe("Document slug"),
      target_space: z.string().optional().describe("Destination space slug (omit to keep in same space)"),
      target_section: z.string().optional().describe("Destination section slug (or null to remove from section)"),
    },
    async ({ space, slug, target_space, target_section }) => {
      const body: Record<string, any> = {};
      if (target_space) body.space = target_space;
      if (target_section !== undefined) body.section = target_section;

      const doc = await apiFetch(`/api/documents/${space}/${slug}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

      const dest = target_space || space;
      return { content: [{ type: "text" as const, text: `Moved ${slug} to ${dest}${doc.sectionSlug ? `/${doc.sectionSlug}` : ""}` }] };
    },
  );

  server.tool(
    "duplicate_doc",
    'Create a copy of a document, optionally in a different space. Example: duplicate_doc("engineering", "api-design")',
    {
      space: z.string().describe("Source space slug"),
      slug: z.string().describe("Source document slug"),
      target_space: z.string().optional().describe("Destination space slug (default: same space)"),
      target_slug: z.string().optional().describe('Custom slug for the copy (default: "{slug}-copy")'),
    },
    async ({ space, slug, target_space, target_slug }) => {
      const body: Record<string, any> = {};
      if (target_space) body.targetSpace = target_space;
      if (target_slug) body.targetSlug = target_slug;

      const doc = await apiFetch(`/api/documents/${space}/${slug}/duplicate`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      return { content: [{ type: "text" as const, text: `Duplicated to ${doc.slug} in ${target_space || space}` }] };
    },
  );

  server.tool(
    "delete_doc",
    'Permanently delete a document and all its versions. This cannot be undone. Example: delete_doc("engineering", "old-draft")',
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
    "List version history of a document. Shows version number, content hash, and creation date for each version.",
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

  // --- Comments ---

  server.tool(
    "add_comment",
    'Add a comment to a document. Comments can be anchored to specific text for inline discussion. For anchored comments, provide the exact text passage and the section heading path. Example: add_comment("engineering", "api-design", "Should we use UUIDs here?", anchor_text="All IDs are auto-incrementing integers")',
    {
      space: z.string().describe("Space slug"),
      slug: z.string().describe("Document slug"),
      body: z.string().describe("Comment text (markdown supported)"),
      anchor_text: z.string().optional().describe("Exact text passage to anchor this comment to"),
      anchor_section: z.string().optional().describe('Section heading path, e.g. "## Authentication > ### Token Format"'),
      parent_id: z.string().optional().describe("Parent comment ID to reply to an existing comment thread"),
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
    "List all comments on a document. Shows author, body, anchor text, section, and resolved status. Resolved comments are hidden by default.",
    {
      space: z.string().describe("Space slug"),
      slug: z.string().describe("Document slug"),
      include_resolved: z.boolean().optional().describe("Include resolved/closed comments (default: false)"),
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
    "Toggle a comment thread as resolved or reopened. Resolved comments are hidden from the default view.",
    {
      space: z.string().describe("Space slug"),
      slug: z.string().describe("Document slug"),
      comment_id: z.string().describe("Comment ID (from list_comments output)"),
    },
    async ({ space, slug, comment_id }) => {
      const comment = await apiFetch(`/api/comments/${space}/${slug}/${comment_id}/resolve`, {
        method: "POST",
      });
      return { content: [{ type: "text" as const, text: `Comment ${comment.resolved ? "resolved" : "reopened"}` }] };
    },
  );

  // --- Search ---

  server.tool(
    "search_docs",
    'Search for documents by title across all accessible spaces. Returns matching space/slug pairs. Example: search_docs("api")',
    { query: z.string().describe("Search term to match against document titles and slugs") },
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
}

export { INSTRUCTIONS };
