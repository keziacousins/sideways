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

export interface RenderOptions {
  /** "web" includes interactive features; "pdf" produces print-ready HTML */
  target: "web" | "pdf";
}

/**
 * Create the shared remark/rehype processor.
 * Used by both the web viewer and the PDF pipeline.
 */
export function createProcessor(options: RenderOptions = { target: "web" }) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(rehypeHighlight)
    .use(rehypeKatex)
    .use(rehypeStringify, { allowDangerousHtml: true });

  return processor;
}

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
