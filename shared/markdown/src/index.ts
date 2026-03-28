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
import { remarkWikiLinks } from "./wikilinks.js";

export interface RenderOptions {
  /** "web" includes interactive features; "pdf" produces print-ready HTML */
  target: "web" | "pdf";
  /** Space slug for resolving wiki-links like [[doc-slug]] */
  spaceSlug?: string;
}

/**
 * Create the shared remark/rehype processor.
 * Used by both the web viewer and the PDF pipeline.
 */
// Sanitize schema: allow KaTeX, highlight.js classes, heading IDs, task list checkboxes
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] || []), "className", "id", "style"],
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
    .use(remarkMath)
    .use(remarkWikiLinks(options.spaceSlug))
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
