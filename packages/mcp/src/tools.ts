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

const INSTRUCTIONS = `Sideways is a documentation platform. Capabilities:
- Spaces: create, list (top-level containers)
- Sections: create (the first path segment inside a space; must exist before doc_write)
- Documents: read, write, edit (in-place), rename, move, duplicate, delete, version history
- Comments: add, list, resolve, reply (threaded, optionally anchored to text)
- Search: full-text across documents

ALWAYS pass \`ref\` to doc and comment tools — never \`space\` + \`path\` separately. Refs have the form \`<space>:<section>/<path>.md\`, e.g. \`engineering:architecture/api-design.md\`. \`search\` and \`doc_list\` emit refs you can copy verbatim into doc_read, doc_edit, comment_add, etc. The first segment after the colon is the section (a filesystem-shaped grouping); the rest is the path within that section.

Concepts:
- doc_write is an upsert: creates the doc if its ref is new, updates otherwise. The section must exist first — use section_create if you're writing into a new section (every space starts with a \`default\` section).
- doc_edit applies search/replace pairs sequentially; if any \`old\` string is not found the whole edit fails.
- Comments can be anchored to exact text passages for inline review.

URL form: \`/s/<space>/<path-without-md>\` (with \`<dir>/index.md\` collapsed to \`<dir>\`).`;

export function registerTools(server: McpServer, apiFetch: ApiFetch) {
  // --- Spaces ---

  server.tool(
    "space_list",
    "List spaces the user can access. Returns slug, name, visibility, and description.",
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
    "space_create",
    'Create a documentation space. Visibility: "public" (anyone), "private" (owner + members, default), "shared" (anyone with the link), "org" (authenticated users).',
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

      const space = await apiFetch(`/api/spaces/${encodeURIComponent(slug)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      return { content: [{ type: "text" as const, text: `Created space "${space.name}" (${space.slug}, ${space.visibility})` }] };
    },
  );

  server.tool(
    "section_create",
    "Create a section within a space, or update an existing section's title/position (upsert by slug). Sections are the first path segment after the space colon in a ref (e.g. `architecture` in `engineering:architecture/api-design.md`) and must exist before doc_write can target them. Every space starts with a `default` section.",
    {
      space: z.string().describe('Space slug, e.g. "engineering"'),
      slug: z.string().describe('URL-friendly section identifier, e.g. "architecture"'),
      title: z.string().optional().describe("Display title (defaults to the slug)"),
      position: z.number().int().optional().describe("Sort position in the space sidebar (default: 0)"),
    },
    async ({ space, slug, title, position }) => {
      const body: Record<string, any> = {};
      if (title) body.title = title;
      if (position !== undefined) body.position = position;

      const section = await apiFetch(
        `/api/spaces/${encodeURIComponent(space)}/sections/${encodeURIComponent(slug)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );

      return {
        content: [{
          type: "text" as const,
          text: `Section ready: ${space}:${section.slug} — "${section.title}"`,
        }],
      };
    },
  );

  // --- Documents ---

  /** Parse a `<space>:<section>/<rest>` ref into its three API-shaped parts. */
  function parseRef(ref: string): { space: string; section: string; rest: string } {
    const colon = ref.indexOf(":");
    if (colon === -1) {
      throw new Error(
        `Invalid ref "${ref}" — expected "<space>:<section>/<path>.md" (e.g. "engineering:architecture/api-design.md")`,
      );
    }
    const space = ref.slice(0, colon);
    const path = ref.slice(colon + 1);
    const slash = path.indexOf("/");
    if (slash === -1) {
      // section-only ref = section's index doc
      return { space, section: path, rest: "index.md" };
    }
    return { space, section: path.slice(0, slash), rest: path.slice(slash + 1) };
  }

  /** Inverse of parseRef — build the canonical ref string. */
  function formatRef(space: string, sectionSlug: string, path: string): string {
    return `${space}:${sectionSlug}/${path}`;
  }

  /**
   * URL-encode each segment of a doc path (which contains slashes) without
   * encoding the slashes themselves. encodeURIComponent on the whole path
   * would break API routing; encodeURI is too permissive. This keeps each
   * segment safe to interpolate into a URL.
   */
  function encodePath(p: string): string {
    return p.split("/").map(encodeURIComponent).join("/");
  }

  /** Schema description shared by every `ref` arg, so renames stay consistent. */
  const REF_DESC =
    'Document ref: "<space>:<section>/<path>.md", e.g. "engineering:architecture/api-design.md". Copy verbatim from search or doc_list output.';

  server.tool(
    "doc_list",
    "List documents in a space. Each line is a doc_read-ready ref followed by the title.",
    { space: z.string().describe('Space slug, e.g. "engineering"') },
    async ({ space }) => {
      const docs = await apiFetch(`/api/documents?space=${encodeURIComponent(space)}`);
      const text = docs
        .map((d: any) => {
          const tags = d.tags?.length ? ` [${d.tags.join(", ")}]` : "";
          return `${formatRef(space, d.sectionSlug, d.path)} — ${d.title}${tags}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text: text || "No documents in this space." }] };
    },
  );

  server.tool(
    "doc_read",
    'Read a document by ref (e.g. "engineering:architecture/api-design.md"). Comments are embedded at the end as HTML comment blocks unless disabled.',
    {
      ref: z.string().describe(REF_DESC),
      include_comments: z.boolean().optional().describe("Embed comments as <!-- @comment --> blocks at the end (default: true)"),
    },
    async ({ ref, include_comments }) => {
      const { space, section, rest } = parseRef(ref);
      const doc = await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`);
      let content = doc.content;

      if (include_comments !== false) {
        try {
          const comments = await apiFetch(`/api/comments/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`);
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

      const meta = `${ref} — ${doc.title}`;
      return { content: [{ type: "text" as const, text: `${meta}\n---\n${content}` }] };
    },
  );

  server.tool(
    "doc_write",
    'Create or update a document by ref (e.g. "engineering:architecture/api-design.md"). Upserts on ref: existing docs get a new version, new refs create the doc. Title is auto-extracted from the first # heading if omitted.',
    {
      ref: z.string().describe(REF_DESC),
      content: z.string().describe("Full markdown content of the document"),
      title: z.string().optional().describe("Document title (auto-extracted from first # heading if omitted)"),
      tags: z.array(z.string()).optional().describe('Tags for categorization, e.g. ["api", "architecture"]'),
    },
    async ({ ref, content, title, tags }) => {
      const { space, section, rest } = parseRef(ref);
      const body: Record<string, any> = { content };
      if (title) body.title = title;
      if (tags) body.tags = tags;

      const doc = await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      return { content: [{ type: "text" as const, text: `Saved ${formatRef(space, doc.sectionSlug, doc.path)} — ${doc.title}` }] };
    },
  );

  server.tool(
    "doc_edit",
    'Apply search-and-replace edits to a document by ref (e.g. "engineering:architecture/api-design.md") without rewriting it. Edits run sequentially; if any `old` string is not found, the whole edit fails and nothing is saved. Use doc_read first to see current content.',
    {
      ref: z.string().describe(REF_DESC),
      edits: z.array(z.object({
        old: z.string().describe("Exact string to find in the document"),
        new: z.string().describe("Replacement string"),
      })).describe("List of search/replace pairs to apply sequentially"),
    },
    async ({ ref, edits }) => {
      const { space, section, rest } = parseRef(ref);
      const doc = await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`);
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

      await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });

      return { content: [{ type: "text" as const, text: `Applied ${edits.length} edit${edits.length !== 1 ? "s" : ""} to ${ref}` }] };
    },
  );

  server.tool(
    "doc_rename",
    'Change a document\'s title by ref (e.g. "engineering:architecture/api-design.md"). Path-changing renames go through doc_move.',
    {
      ref: z.string().describe(REF_DESC),
      title: z.string().describe("New title"),
    },
    async ({ ref, title }) => {
      const { space, section, rest } = parseRef(ref);
      const doc = await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      return { content: [{ type: "text" as const, text: `Renamed ${ref} — "${doc.title}"` }] };
    },
  );

  server.tool(
    "doc_move",
    'Move a document (identified by ref, e.g. "engineering:architecture/api-design.md") to a different space, section, or path. Each target_* arg is optional; omitted ones stay the same.',
    {
      ref: z.string().describe(REF_DESC),
      target_space: z.string().optional().describe("Destination space slug (omit to keep in same space)"),
      target_section: z.string().optional().describe("Destination section slug (omit to keep in same section)"),
      target_path: z.string().optional().describe('Destination path within section (e.g. "architecture/foo.md")'),
    },
    async ({ ref, target_space, target_section, target_path }) => {
      const { space, section, rest } = parseRef(ref);
      const body: Record<string, any> = {};
      if (target_space) body.targetSpace = target_space;
      if (target_section) body.targetSection = target_section;
      if (target_path) body.targetPath = target_path;

      const doc = await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

      const destSpace = target_space || space;
      return { content: [{ type: "text" as const, text: `Moved to ${formatRef(destSpace, doc.sectionSlug, doc.path)}` }] };
    },
  );

  server.tool(
    "doc_duplicate",
    'Copy a document (identified by ref, e.g. "engineering:architecture/api-design.md"), optionally into a different space, section, or path. Defaults to `<source>-copy.md` in the same place.',
    {
      ref: z.string().describe(REF_DESC),
      target_space: z.string().optional().describe("Destination space slug (default: same space)"),
      target_section: z.string().optional().describe("Destination section slug (default: same section)"),
      target_path: z.string().optional().describe('Custom path for the copy (default: "<source>-copy.md")'),
    },
    async ({ ref, target_space, target_section, target_path }) => {
      const { space, section, rest } = parseRef(ref);
      const body: Record<string, any> = {};
      if (target_space) body.targetSpace = target_space;
      if (target_section) body.targetSection = target_section;
      if (target_path) body.targetPath = target_path;

      const doc = await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/_duplicate/${encodePath(rest)}`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      const destSpace = target_space || space;
      return { content: [{ type: "text" as const, text: `Duplicated to ${formatRef(destSpace, doc.sectionSlug, doc.path)}` }] };
    },
  );

  server.tool(
    "doc_delete",
    'Permanently delete a document by ref (e.g. "engineering:architecture/api-design.md") and all its versions. Cannot be undone.',
    {
      ref: z.string().describe(REF_DESC),
    },
    async ({ ref }) => {
      const { space, section, rest } = parseRef(ref);
      await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`, { method: "DELETE" });
      return { content: [{ type: "text" as const, text: `Deleted ${ref}` }] };
    },
  );

  server.tool(
    "doc_versions",
    'List a document\'s version history by ref (e.g. "engineering:architecture/api-design.md") with version number, content hash, and creation date.',
    {
      ref: z.string().describe(REF_DESC),
    },
    async ({ ref }) => {
      const { space, section, rest } = parseRef(ref);
      const versions = await apiFetch(`/api/documents/${encodeURIComponent(space)}/${encodeURIComponent(section)}/_versions/${encodePath(rest)}`);
      const text = versions
        .map((v: any) => `v${v.version} — ${v.contentHash} — ${new Date(v.createdAt).toLocaleString()}`)
        .join("\n");
      return { content: [{ type: "text" as const, text: text || "No versions." }] };
    },
  );

  // --- Comments ---

  server.tool(
    "comment_add",
    'Add a comment to a document by ref (e.g. "engineering:architecture/api-design.md"), or reply to an existing thread. Optionally anchor to a specific text passage for inline review.',
    {
      ref: z.string().describe(REF_DESC),
      body: z.string().describe("Comment text (markdown supported)"),
      anchor_text: z.string().optional().describe("Exact text passage to anchor this comment to"),
      anchor_section: z.string().optional().describe('Section heading path, e.g. "## Authentication > ### Token Format"'),
      parent_id: z.string().optional().describe("Parent comment ID to reply to an existing comment thread"),
    },
    async ({ ref, body, anchor_text, anchor_section, parent_id }) => {
      const { space, section, rest } = parseRef(ref);
      const payload: Record<string, any> = { body };
      if (anchor_text) payload.anchorText = anchor_text;
      if (anchor_section) payload.anchorSection = anchor_section;
      if (parent_id) payload.parentId = parent_id;

      const comment = await apiFetch(`/api/comments/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      return { content: [{ type: "text" as const, text: `Comment added (${comment.id})` }] };
    },
  );

  server.tool(
    "comment_list",
    'List comments on a document by ref (e.g. "engineering:architecture/api-design.md"), threaded by parent. Resolved comments are hidden unless include_resolved is set.',
    {
      ref: z.string().describe(REF_DESC),
      include_resolved: z.boolean().optional().describe("Include resolved/closed comments (default: false)"),
    },
    async ({ ref, include_resolved }) => {
      const { space, section, rest } = parseRef(ref);
      const qs = include_resolved ? "?include_resolved=true" : "";
      const comments = await apiFetch(`/api/comments/${encodeURIComponent(space)}/${encodeURIComponent(section)}/${encodePath(rest)}${qs}`);

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
    "comment_resolve",
    "Toggle a comment thread between resolved and reopened. Resolved threads are hidden from the default view.",
    {
      comment_id: z.string().describe("Comment ID (from comment_list output)"),
    },
    async ({ comment_id }) => {
      const comment = await apiFetch(`/api/comments/${encodeURIComponent(comment_id)}/resolve`, { method: "POST" });
      return { content: [{ type: "text" as const, text: `Comment ${comment.resolved ? "resolved" : "reopened"}` }] };
    },
  );

  // --- Search ---

  server.tool(
    "search",
    "Full-text search across accessible documents by title, tags, and content. Returns ranked results with snippets. Optionally limit to one space.",
    {
      query: z.string().describe("Search query — searches titles, tags, and document content"),
      space: z.string().optional().describe("Limit search to a specific space slug"),
    },
    async ({ query, space }) => {
      const params = new URLSearchParams({ q: query, limit: "20" });
      if (space) params.set("space", space);
      const data = await apiFetch(`/api/search?${params}`);
      const text = data.results
        .map((r: any) => `${formatRef(r.spaceSlug, r.sectionSlug, r.path)} — ${r.title}\n  ${r.snippet?.replace(/<[^>]+>/g, "") || ""}`)
        .join("\n\n");
      return { content: [{ type: "text" as const, text: text || "No documents found." }] };
    },
  );
}

export { INSTRUCTIONS };
