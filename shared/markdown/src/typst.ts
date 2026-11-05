/**
 * Rehype plugin: Typst + CeTZ diagrams (see issue #117).
 *
 * Unlike mermaid, a Typst diagram is rendered on the server for BOTH targets —
 * there is no browser-side Typst — and it reaches the page as an `<img>`, not
 * as inline SVG:
 *
 *   - An SVG loaded through `<img>` is inert: no scripts, no external fetches,
 *     no styles leaking into the page. So the diagram never goes near the
 *     sanitiser's SVG allow-list, which exists for mermaid's inline SVG.
 *   - Typst SVG is heavy (glyph outlines plus embedded icons, often several
 *     hundred KB), which is better fetched and cached on its own than inlined
 *     into every page view.
 *
 * Where the `<img>` points is the caller's business: `renderTypst` returns
 * the `src` — a stored, content-addressed URL for the cached web view, a
 * `data:` URI for the PDF (WeasyPrint can't fetch access-controlled URLs) and
 * for editor previews (no point storing every keystroke).
 *
 * Runs AFTER rehype-sanitize, like rehypeAssets: everything it writes is markup
 * we built, around a URL the caller built, and a `data:` src is exactly what
 * the sanitiser would (rightly) strip from author-written HTML. It reads the
 * fence's source as text, so it doesn't matter whether rehype-highlight got to
 * it first — highlight.js has no Typst grammar, and leaves it alone anyway.
 *
 * With no `renderTypst` (e.g. contexts that only need text), the fence stays a
 * plain code block. A failed render keeps the code block and adds a note, so a
 * broken diagram never takes the document down with it.
 */

import { visit } from "unist-util-visit";
import type { Element, ElementContent, Parent, Root, RootContent } from "hast";
import { assetMimeType, resolveRelativePath } from "@sideways/types";
import { splitRelativeRef } from "./relative.js";

const TYPST_LANGUAGE_CLASS = "language-typst";

/** What `renderTypst` hands back for one diagram. */
export interface TypstDiagram {
  /** The `<img>` src: a URL or a `data:` URI. */
  src: string;
  /** Natural size in CSS px, so the image is only ever scaled down. */
  width?: number;
  height?: number;
}

export interface TypstOptions {
  renderTypst?: (source: string) => Promise<TypstDiagram>;
}

// A string literal in Typst source, escapes and all.
const STRING_LITERAL_RE = /"((?:[^"\\\n]|\\.)*)"/g;

/**
 * The hosted files a diagram reads, as section-relative paths, each once.
 *
 * A diagram names images the way markdown does — relative to the document,
 * `image("./img/logo.png")` — and the renderer hands it those files. Which
 * files is decided from the source text: every string literal that resolves,
 * relative to the document, to a path of a hosted type. So a path has to be
 * written out literally; one built up at run time isn't seen, and the diagram
 * gets "file not found" for it. Strings that merely look like paths cost a
 * lookup that finds nothing. Like markdown, nothing outside the section.
 */
export function typstAssetRefs(source: string, docPath: string): string[] {
  const paths = new Set<string>();
  for (const [, literal] of source.matchAll(STRING_LITERAL_RE)) {
    const split = splitRelativeRef(literal.replace(/\\(.)/g, "$1"));
    if (!split || split.suffix) continue;
    const path = resolveRelativePath(docPath, split.target);
    if (path && assetMimeType(path)) paths.add(path);
  }
  return [...paths];
}

export function rehypeTypst(options: TypstOptions) {
  return async (tree: Root): Promise<undefined> => {
    const { renderTypst } = options;
    if (!renderTypst) return;

    const found: Array<{ parent: Parent; index: number; source: string }> = [];
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "pre" || !parent || index === undefined) return;
      const source = typstSource(node);
      if (source === undefined) return;
      found.push({ parent, index, source });
    });
    if (found.length === 0) return;

    // All renders in flight at once; the caller's renderer owns concurrency and
    // budgets, as with mermaid. `replacement` never rejects.
    const replacements = await Promise.all(
      found.map(({ parent, index, source }) => replacement(source, parent.children[index] as Element, renderTypst)),
    );

    // Back to front: a failure expands into two siblings.
    for (let i = found.length - 1; i >= 0; i--) {
      const { parent, index } = found[i];
      parent.children.splice(index, 1, ...replacements[i]);
    }
  };
}

/** The source of a ```typst fence, or undefined for any other `pre`. */
function typstSource(pre: Element): string | undefined {
  const code = pre.children.find((child): child is Element => child.type === "element");
  if (!code || code.tagName !== "code") return undefined;
  const classes = code.properties?.className;
  if (!Array.isArray(classes) || !classes.includes(TYPST_LANGUAGE_CLASS)) return undefined;
  return textOf(code);
}

function textOf(node: ElementContent | Element): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

async function replacement(
  source: string,
  original: Element,
  renderTypst: NonNullable<TypstOptions["renderTypst"]>,
): Promise<RootContent[]> {
  try {
    return [diagramFigure(await renderTypst(source))];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [original, errorNote(message)];
  }
}

function diagramFigure({ src, width, height }: TypstDiagram): Element {
  const img: Element = {
    type: "element",
    tagName: "img",
    properties: {
      src,
      alt: "Diagram",
      ...(width ? { width: Math.round(width) } : {}),
      ...(height ? { height: Math.round(height) } : {}),
    },
    children: [],
  };
  return {
    type: "element",
    tagName: "figure",
    properties: { className: ["typst-diagram"] },
    children: [img],
  };
}

function errorNote(message: string): Element {
  return {
    type: "element",
    tagName: "p",
    properties: { className: ["typst-error"] },
    children: [{ type: "text", value: `Diagram failed to render: ${message}` }],
  };
}
