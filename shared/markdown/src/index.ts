import { unified } from "unified";
import { visit } from "unist-util-visit";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Root, Element } from "hast";
import { remarkWikiLinks, escapeWikiLinkPipes, type WikiLinkContext } from "./wikilinks.js";

export interface RenderOptions {
  /** "web" includes interactive features; "pdf" produces print-ready HTML */
  target: "web" | "pdf";
  /**
   * Context for resolving `[[wikilinks]]` against the doc list. If omitted,
   * all wikilinks render as unresolved spans.
   */
  wikiLinks?: WikiLinkContext;
}

/**
 * Create the shared remark/rehype processor.
 * Used by both the web viewer and the PDF pipeline.
 */
// Prefix applied to element IDs in the rendered doc to defend against
// DOM clobbering. Must match what hast-util-sanitize uses (its default).
// Exposed so the rendering pages can ship a small client-side shim that
// resolves external `#anchor` URLs after the prefix has been applied.
export const ID_CLOBBER_PREFIX = "user-content-";

// Sanitize schema: allow KaTeX, highlight.js classes, heading IDs, task list checkboxes.
// hast-util-sanitize's per-tag attribute lists OVERRIDE the `*` wildcard (they
// don't merge), so any tag we want className on needs it listed explicitly.
// `<a>` defaults to allowing only `data-footnote-backref` as a className value;
// we override to allow any class so wiki-link, etc. survive.
const sanitizeSchema = {
  ...defaultSchema,
  // We keep hast-util-sanitize's default clobberPrefix ('user-content-').
  // rehype-autolink-headings is configured below to emit hrefs with the
  // same prefix so heading auto-links keep working. External '#foo' URLs
  // are resolved by a small DOMContentLoaded shim in the doc-rendering
  // page (looks for the prefixed id when the bare one isn't found).
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] || []), "className", "id", "style"],
    // hast-util-sanitize takes the FIRST matching attribute definition. The
    // default schema for <a> has a restrictive [['className', 'data-footnote-
    // backref']] entry that would match first and strip everything else, so
    // we prepend the permissive 'className' so it wins.
    a: ["className", ...(defaultSchema.attributes?.["a"] || [])],
    input: ["type", "checked", "disabled"],
    span: [...(defaultSchema.attributes?.["span"] || []), "className", "style"],
    div: [...(defaultSchema.attributes?.["div"] || []), "className", "style"],
    code: [...(defaultSchema.attributes?.["code"] || []), "className"],
    pre: [...(defaultSchema.attributes?.["pre"] || []), "className"],
    math: ["xmlns", "display"],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "math", "mi", "mo", "mn", "ms", "mtext", "mspace", "mover", "munder",
    "munderover", "msub", "msup", "msubsup", "mfrac", "mroot", "msqrt",
    "mtable", "mtr", "mtd", "mrow", "annotation", "semantics",
    "span", "div", "input", "section", "details", "summary",
  ],
};

/**
 * Prefix `<a href="#foo">` hrefs to match the clobber-prefixed element
 * ids we render. Runs after rehype-autolink-headings (whose hardcoded
 * href would otherwise win over a user `properties` callback) and
 * before rehype-sanitize. Covers heading auto-links AND inline markdown
 * anchors written like `[section](#section)`.
 *
 * `<a href="#">` (browser "scroll to top") and empty fragments are left
 * alone. Already-prefixed hrefs (defensive) are also left alone.
 */
function rehypePrefixAnchorHrefs() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string" || href.length < 2 || !href.startsWith("#")) return;
      if (href.startsWith(`#${ID_CLOBBER_PREFIX}`)) return;
      node.properties = { ...node.properties, href: `#${ID_CLOBBER_PREFIX}${href.slice(1)}` };
    });
  };
}

export function createProcessor(options: RenderOptions = { target: "web" }) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkWikiLinks(options.wikiLinks))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(rehypePrefixAnchorHrefs)
    .use(rehypeHighlight)
    .use(rehypeKatex)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify);

  return processor;
}

export { extractComments, embedComments } from "./comments.js";
export type { SerializedComment } from "./comments.js";
export type { WikiLinkContext, WikiLinkDoc, WikiLinkSection } from "./wikilinks.js";

/**
 * Cache-key segment for rendered HTML. Bump whenever renderer output changes
 * meaningfully (new plugin, changed sanitiser, wikilink semantics, etc.) so
 * cached entries from previous renderer versions are no longer served.
 *
 * v3: restored DOM-clobber prefix on element IDs + autolink hrefs.
 * v4: wikilinks now parse `#fragment` suffixes and emit prefixed hrefs.
 * v5: inline `[text](#foo)` anchors also get the clobber prefix; heading
 *     auto-links now actually carry the prefixed href (the v3 attempt
 *     was a no-op — rehype-autolink-headings overrides `properties.href`).
 * v6: disabled single-`$` inline math — `$2k`-style currency in prose was
 *     being parsed as math. Use `$$...$$` for math now.
 * v7: pre-escape `|` inside `[[…]]` so wikilinks with display labels
 *     survive inside GFM table cells.
 */
export const RENDERER_VERSION = "v7";

/**
 * Render markdown to HTML string.
 */
export async function renderMarkdown(
  markdown: string,
  options: RenderOptions = { target: "web" },
): Promise<string> {
  const processor = createProcessor(options);
  const result = await processor.process(escapeWikiLinkPipes(markdown));
  return String(result);
}
