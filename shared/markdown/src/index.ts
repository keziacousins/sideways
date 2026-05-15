import { unified } from "unified";
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
import { remarkWikiLinks, type WikiLinkContext } from "./wikilinks.js";

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
// Sanitize schema: allow KaTeX, highlight.js classes, heading IDs, task list checkboxes.
// hast-util-sanitize's per-tag attribute lists OVERRIDE the `*` wildcard (they
// don't merge), so any tag we want className on needs it listed explicitly.
// `<a>` defaults to allowing only `data-footnote-backref` as a className value;
// we override to allow any class so wiki-link, etc. survive.
const sanitizeSchema = {
  ...defaultSchema,
  // Disable the DOM-clobber prefix. Default behaviour prefixes element IDs
  // with `user-content-` to defend against `document.<id>`-style clobbering,
  // but rehype-autolink-headings runs BEFORE sanitiser and emits hrefs
  // without the prefix — so heading auto-links and external `#anchor` URLs
  // never resolve to their headings. We trust author content enough to
  // render arbitrary markdown; clobber defence isn't load-bearing here.
  clobberPrefix: "",
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

export function createProcessor(options: RenderOptions = { target: "web" }) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkWikiLinks(options.wikiLinks))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
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
 */
export const RENDERER_VERSION = "v2";

/**
 * Render markdown to HTML string.
 */
export async function renderMarkdown(
  markdown: string,
  options: RenderOptions = { target: "web" },
): Promise<string> {
  const processor = createProcessor(options);
  const result = await processor.process(markdown);
  return String(result);
}
