/**
 * MCP tool registrations — shared between stdio and SSE transports.
 *
 * Doc references use a two-arg shape: `(space, path)` where `path` is the
 * filesystem-shaped doc path including its section prefix as the first
 * segment, e.g. `architecture/overview.md` lives in section `architecture`,
 * `plans/canvas-foundations-v1/PLAN.md` lives in section `plans`. The
 * server splits on the first slash.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type ApiFetch = (path: string, options?: RequestInit) => Promise<any>;

const INSTRUCTIONS = `Sideways is a documentation sharing platform. The data model is:

- **Spaces**: Top-level containers (like projects or teams). Each has a slug, name, visibility (public/private/shared/org), and an owner.
- **Sections**: Filesystem-shaped groupings within a space. A section is the first segment of a doc's path.
- **Documents**: Versioned markdown files. Identified by \`(space, path)\` where \`path\` is the filesystem path including section prefix and \`.md\` extension — e.g. \`architecture/overview.md\` is a doc in the \`architecture\` section.
- **Comments**: Threaded discussions on documents, optionally anchored to specific text.

URL form: \`/s/<space>/<path-without-md>\` (with \`<dir>/index.md\` collapsed to \`<dir>\`).

Common workflows:
- Create documentation for a new project: create_space → write_doc (repeating for each document)
- Review a document: read_doc → add_comment (with anchor_text for inline comments)
- Reorganize: rename_doc (title only), move_doc (path/section/space change)
- write_doc is an upsert: creates the doc if its path is new, updates otherwise.`;

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

  function splitPath(path: string): { section: string; rest: string } {
    const slash = path.indexOf("/");
    if (slash === -1) {
      // Single-segment path = section root index doc
      return { section: path, rest: "index.md" };
    }
    return { section: path.slice(0, slash), rest: path.slice(slash + 1) };
  }

  server.tool(
    "list_docs",
    'List all documents in a space. Returns path, title, and tags for each document. Example: list_docs("engineering")',
    { space: z.string().describe('Space slug, e.g. "engineering"') },
    async ({ space }) => {
      const docs = await apiFetch(`/api/documents?space=${space}`);
      const text = docs
        .map((d: any) => {
          const tags = d.tags?.length ? ` [${d.tags.join(", ")}]` : "";
          return `${d.sectionSlug}/${d.path}: ${d.title}${tags}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text: text || "No documents in this space." }] };
    },
  );

  server.tool(
    "read_doc",
    'Read a document\'s full markdown content. Path includes section prefix and `.md`. Optionally includes comments embedded as HTML comment blocks. Example: read_doc("engineering", "architecture/api-design.md")',
    {
      space: z.string().describe('Space slug, e.g. "engineering"'),
      path: z.string().describe('Doc path including section, e.g. "architecture/api-design.md"'),
      include_comments: z.boolean().optional().describe("Embed comments as <!-- @comment --> blocks at the end (default: true)"),
    },
    async ({ space, path, include_comments }) => {
      const { section, rest } = splitPath(path);
      const doc = await apiFetch(`/api/documents/${space}/${section}/${rest}`);
      let content = doc.content;

      if (include_comments !== false) {
        try {
          const comments = await apiFetch(`/api/comments/${space}/${section}/${rest}`);
          if (comments.length > 0) {
            const lines: string[] = [];
            for (const c of comments) {
              const author = c.author?.name || "Unknown";
              const date = c.createdAt?.slice(0, 10) || "";
              const sectionAttr = c.anchorSection ? ` section="${c.anchorSection}"` : "";
              const anchor = c.anchorText ? ` anchor="${c.anchorText}"` : "";
              const parent = c.parentId ? ` parent="${c.parentId}"` : "";
              lines.push(`<!-- @comment id="${c.id}" author="${author}" date="${date}"${sectionAttr}${anchor}${parent}\n${c.body}\n-->`);
            }
            content = content + "\n\n" + lines.join("\n\n");
          }
        } catch {}
      }

      const meta = `Space: ${space} | Path: ${path} | Title: ${doc.title}`;
      return { content: [{ type: "text" as const, text: `${meta}\n---\n${content}` }] };
    },
  );

  server.tool(
    "write_doc",
    'Create or update a document (upsert). If the path already exists, creates a new version. Otherwise creates the doc. The title is auto-extracted from the first # heading if not provided. Example: write_doc("engineering", "architecture/api-design.md", "# API Design Guide\\n\\nOur API follows REST conventions...")',
    {
      space: z.string().describe('Space slug, e.g. "engineering"'),
      path: z.string().describe('Doc path including section and `.md`, e.g. "architecture/api-design.md". Section is the first segment.'),
      content: z.string().describe("Full markdown content of the document"),
      title: z.string().optional().describe("Document title (auto-extracted from first # heading if omitted)"),
      tags: z.array(z.string()).optional().describe('Tags for categorization, e.g. ["api", "architecture"]'),
    },
    async ({ space, path, content, title, tags }) => {
      const { section, rest } = splitPath(path);
      const body: Record<string, any> = { content };
      if (title) body.title = title;
      if (tags) body.tags = tags;

      const doc = await apiFetch(`/api/documents/${space}/${section}/${rest}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      return { content: [{ type: "text" as const, text: `Saved ${space}/${path} (${doc.title})` }] };
    },
  );

  server.tool(
    "edit_doc",
    'Apply search-and-replace edits to a document without rewriting the whole thing. Each edit specifies an exact string to find and its replacement. Edits are applied sequentially. If any "old" string is not found, the operation fails with an error showing which edit failed. Use read_doc first to see the current content. Example: edit_doc("finco", "architecture/api-design.md", [{ old: "Status: Draft", new: "Status: Approved" }])',
    {
      space: z.string().describe('Space slug, e.g. "finco"'),
      path: z.string().describe('Doc path including section, e.g. "architecture/api-design.md"'),
      edits: z.array(z.object({
        old: z.string().describe("Exact string to find in the document"),
        new: z.string().describe("Replacement string"),
      })).describe("List of search/replace pairs to apply sequentially"),
    },
    async ({ space, path, edits }) => {
      const { section, rest } = splitPath(path);
      const doc = await apiFetch(`/api/documents/${space}/${section}/${rest}`);
      let content: string = doc.content;

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const idx = content.indexOf(edit.old);
        if (idx === -1) {
          return {
            content: [{
              type: "text" as const,
              text: `Edit ${i + 1} failed: could not find "${edit.old.slice(0, 100)}${edit.old.length > 100 ? "..." : ""}" in the document. No changes were saved.`,
            }],
            isError: true,
          };
        }
        content = content.slice(0, idx) + edit.new + content.slice(idx + edit.old.length);
      }

      await apiFetch(`/api/documents/${space}/${section}/${rest}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });

      return { content: [{ type: "text" as const, text: `Applied ${edits.length} edit${edits.length !== 1 ? "s" : ""} to ${space}/${path}` }] };
    },
  );

  server.tool(
    "rename_doc",
    'Rename a document\'s title. Path-changing renames go through move_doc. Example: rename_doc("engineering", "architecture/api-design.md", "API Design Guide")',
    {
      space: z.string().describe("Space slug"),
      path: z.string().describe("Doc path including section"),
      title: z.string().describe("New title"),
    },
    async ({ space, path, title }) => {
      const { section, rest } = splitPath(path);
      const doc = await apiFetch(`/api/documents/${space}/${section}/${rest}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      return { content: [{ type: "text" as const, text: `Renamed to "${doc.title}" (${space}/${path})` }] };
    },
  );

  server.tool(
    "move_doc",
    'Move a document to a different space, section, or path. Example: move_doc("engineering", "architecture/api-design.md", target_section="platform") or move_doc("engineering", "draft/foo.md", target_path="architecture/foo.md")',
    {
      space: z.string().describe("Current space slug"),
      path: z.string().describe("Current doc path including section"),
      target_space: z.string().optional().describe("Destination space slug (omit to keep in same space)"),
      target_section: z.string().optional().describe("Destination section slug (omit to keep in same section)"),
      target_path: z.string().optional().describe("Destination path within section (e.g. \"architecture/foo.md\")"),
    },
    async ({ space, path, target_space, target_section, target_path }) => {
      const { section, rest } = splitPath(path);
      const body: Record<string, any> = {};
      if (target_space) body.targetSpace = target_space;
      if (target_section) body.targetSection = target_section;
      if (target_path) body.targetPath = target_path;

      const doc = await apiFetch(`/api/documents/${space}/${section}/${rest}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

      const dest = target_space || space;
      return { content: [{ type: "text" as const, text: `Moved to ${dest}/${doc.sectionSlug}/${doc.path}` }] };
    },
  );

  server.tool(
    "duplicate_doc",
    'Create a copy of a document, optionally in a different space, section, or path. Example: duplicate_doc("engineering", "architecture/api-design.md")',
    {
      space: z.string().describe("Source space slug"),
      path: z.string().describe("Source doc path including section"),
      target_space: z.string().optional().describe("Destination space slug (default: same space)"),
      target_section: z.string().optional().describe("Destination section slug (default: same section)"),
      target_path: z.string().optional().describe("Custom path for the copy (default: \"<source>-copy.md\")"),
    },
    async ({ space, path, target_space, target_section, target_path }) => {
      const { section, rest } = splitPath(path);
      const body: Record<string, any> = {};
      if (target_space) body.targetSpace = target_space;
      if (target_section) body.targetSection = target_section;
      if (target_path) body.targetPath = target_path;

      const doc = await apiFetch(`/api/documents/${space}/${section}/_duplicate/${rest}`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      return { content: [{ type: "text" as const, text: `Duplicated to ${target_space || space}/${doc.sectionSlug}/${doc.path}` }] };
    },
  );

  server.tool(
    "delete_doc",
    'Permanently delete a document and all its versions. This cannot be undone. Example: delete_doc("engineering", "drafts/old.md")',
    {
      space: z.string().describe("Space slug"),
      path: z.string().describe("Doc path including section"),
    },
    async ({ space, path }) => {
      const { section, rest } = splitPath(path);
      await apiFetch(`/api/documents/${space}/${section}/${rest}`, { method: "DELETE" });
      return { content: [{ type: "text" as const, text: `Deleted ${space}/${path}` }] };
    },
  );

  server.tool(
    "doc_versions",
    "List version history of a document. Shows version number, content hash, and creation date for each version.",
    {
      space: z.string().describe("Space slug"),
      path: z.string().describe("Doc path including section"),
    },
    async ({ space, path }) => {
      const { section, rest } = splitPath(path);
      const versions = await apiFetch(`/api/documents/${space}/${section}/_versions/${rest}`);
      const text = versions
        .map((v: any) => `v${v.version} — ${v.contentHash} — ${new Date(v.createdAt).toLocaleString()}`)
        .join("\n");
      return { content: [{ type: "text" as const, text: text || "No versions." }] };
    },
  );

  // --- Comments ---

  server.tool(
    "add_comment",
    'Add a comment to a document. Comments can be anchored to specific text for inline discussion. For anchored comments, provide the exact text passage and the section heading path. Example: add_comment("engineering", "architecture/api-design.md", "Should we use UUIDs here?", anchor_text="All IDs are auto-incrementing integers")',
    {
      space: z.string().describe("Space slug"),
      path: z.string().describe("Doc path including section"),
      body: z.string().describe("Comment text (markdown supported)"),
      anchor_text: z.string().optional().describe("Exact text passage to anchor this comment to"),
      anchor_section: z.string().optional().describe('Section heading path, e.g. "## Authentication > ### Token Format"'),
      parent_id: z.string().optional().describe("Parent comment ID to reply to an existing comment thread"),
    },
    async ({ space, path, body, anchor_text, anchor_section, parent_id }) => {
      const { section, rest } = splitPath(path);
      const payload: Record<string, any> = { body };
      if (anchor_text) payload.anchorText = anchor_text;
      if (anchor_section) payload.anchorSection = anchor_section;
      if (parent_id) payload.parentId = parent_id;

      const comment = await apiFetch(`/api/comments/${space}/${section}/${rest}`, {
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
      path: z.string().describe("Doc path including section"),
      include_resolved: z.boolean().optional().describe("Include resolved/closed comments (default: false)"),
    },
    async ({ space, path, include_resolved }) => {
      const { section, rest } = splitPath(path);
      const qs = include_resolved ? "?include_resolved=true" : "";
      const comments = await apiFetch(`/api/comments/${space}/${section}/${rest}${qs}`);

      if (comments.length === 0) {
        return { content: [{ type: "text" as const, text: "No comments on this document." }] };
      }

      const roots = comments.filter((c: any) => !c.parentId);
      const byParent = new Map<string, any[]>();
      for (const c of comments) {
        if (c.parentId) {
          if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
          byParent.get(c.parentId)!.push(c);
        }
      }

      function formatComment(c: any, indent: string): string {
        const displayName = c.actorName ? `${c.actorName} via ${c.author?.name || "Unknown"}` : (c.author?.name || "Unknown");
        const anchor = c.anchorText ? `\n${indent}  Anchor: "${c.anchorText.slice(0, 80)}"` : "";
        const sectionAttr = c.anchorSection ? `\n${indent}  Section: ${c.anchorSection}` : "";
        const resolved = c.resolved ? " [RESOLVED]" : "";
        let out = `${indent}[${c.id}] ${displayName}${resolved}${sectionAttr}${anchor}\n${indent}  ${c.body}`;
        const replies = byParent.get(c.id) || [];
        for (const r of replies) {
          out += "\n\n" + formatComment(r, indent + "  ");
        }
        return out;
      }

      const text = roots.map((c: any) => formatComment(c, "")).join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "resolve_comment",
    "Toggle a comment thread as resolved or reopened. Resolved comments are hidden from the default view.",
    {
      comment_id: z.string().describe("Comment ID (from list_comments output)"),
    },
    async ({ comment_id }) => {
      const comment = await apiFetch(`/api/comments/${comment_id}/resolve`, { method: "POST" });
      return { content: [{ type: "text" as const, text: `Comment ${comment.resolved ? "resolved" : "reopened"}` }] };
    },
  );

  // --- Search ---

  server.tool(
    "search_docs",
    'Full-text search across all accessible documents by title and content. Returns ranked results with snippets. Example: search_docs("api design")',
    {
      query: z.string().describe("Search query — searches titles, tags, and document content"),
      space: z.string().optional().describe("Limit search to a specific space slug"),
    },
    async ({ query, space }) => {
      const params = new URLSearchParams({ q: query, limit: "20" });
      if (space) params.set("space", space);
      const data = await apiFetch(`/api/search?${params}`);
      const text = data.results
        .map((r: any) => `${r.spaceSlug}/${r.sectionSlug}/${r.path}: ${r.title}\n  ${r.snippet?.replace(/<[^>]+>/g, "") || ""}`)
        .join("\n\n");
      return { content: [{ type: "text" as const, text: text || "No documents found." }] };
    },
  );
}

export { INSTRUCTIONS };
