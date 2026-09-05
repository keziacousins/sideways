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
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import type { Root, Element } from "hast";
import { remarkWikiLinks, escapeWikiLinkPipes, type WikiLinkContext } from "./wikilinks.js";
import { rehypeMermaid } from "./mermaid.js";

export interface RenderOptions {
  /** "web" includes interactive features; "pdf" produces print-ready HTML */
  target: "web" | "pdf";
  /**
   * Context for resolving `[[wikilinks]]` against the doc list. If omitted,
   * all wikilinks render as unresolved spans.
   */
  wikiLinks?: WikiLinkContext;
  /**
   * Renders mermaid diagram source to an SVG string; rejects if the diagram
   * is invalid or the renderer is unreachable. Supplied by the PDF pipeline
   * only (it calls the headless-browser sidecar), because WeasyPrint has no
   * JS runtime. On the web path this is omitted and the browser draws the
   * diagram itself from the source we leave in the document.
   */
  renderMermaid?: (code: string) => Promise<string>;
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

// Mermaid diagrams reach the sanitiser as pre-rendered SVG, but only on the
// pdf path — the web path emits a plain `<pre>` and the browser draws it.
// That SVG is attacker-influenced markup (the labels come from the document)
// and mermaid has a real XSS history, so the allow-list below is only the
// ordinary drawing subtree.
//
// Deliberately absent: `<foreignObject>` (arbitrary HTML back in through the
// side door — and WeasyPrint can't draw it anyway, which is why the sidecar
// runs with htmlLabels:false), `<script>`, every `on*` handler, and
// href/xlink:href pointing anywhere but a local '#' fragment. Absent means
// dropped: the schema is an allow-list.
//
// `<style>` is the exception, and only inside an `<svg>` (see `ancestors`
// below): mermaid keeps node fill, edge stroke and label colour in an
// id-scoped `<style>` block rather than in presentation attributes, so
// dropping it prints every diagram as black boxes. mermaid.ts rewrites that
// block before it gets here — see `rewriteEmbeddedCss` for what survives.
//
// None of these tag names can be reached from markdown source — raw HTML is
// discarded long before the sanitiser — so widening `tagNames` here only
// widens what the sidecar is allowed to hand us.
const SVG_TAG_NAMES = [
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline",
  "polygon", "text", "tspan", "marker", "defs", "symbol", "use", "title",
  "linearGradient", "stop", "clipPath", "pattern",
];

// Geometry and presentation attributes for the tags above, as hast property
// names rather than attribute names — the sanitiser matches against what the
// parser produced ('strokeDashArray', not 'stroke-dasharray'). className/id/
// style are repeated here because array-valued properties never fall through
// to the `*` wildcard once a per-tag list exists; without them every diagram
// would lose its styling hooks.
const SVG_ATTRIBUTES: NonNullable<SanitizeSchema["attributes"]>[string] = [
  "className", "id", "style", "transform", "role", "ariaLabel",
  "ariaLabelledBy", "ariaRoleDescription", "ariaHidden", "xmlSpace",
  "xmlns", "xmlnsXLink",
  // Geometry.
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy",
  "d", "points", "width", "height", "viewBox", "preserveAspectRatio", "offset",
  "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
  "gradientUnits", "gradientTransform", "spreadMethod", "patternUnits",
  "patternTransform", "clipPathUnits", "overflow",
  // Presentation.
  "fill", "fillOpacity", "fillRule", "stroke", "strokeWidth", "strokeDashArray",
  "strokeDashOffset", "strokeLineCap", "strokeLineJoin", "strokeMiterLimit",
  "strokeOpacity", "opacity", "color", "stopColor", "stopOpacity", "fontFamily",
  "fontSize", "fontStyle", "fontWeight", "letterSpacing", "textAnchor",
  "dominantBaseline", "alignmentBaseline", "markerStart", "markerMid",
  "markerEnd", "clipPath", "mask", "filter", "display", "visibility",
  "shapeRendering", "textRendering", "paintOrder", "vectorEffect",
  // `<use href="#node">` and its legacy xlink spelling. Fragments only: an
  // absolute URL here would be an outbound reference from a "static" diagram.
  ["href", /^#/],
  ["xLinkHref", /^#/],
];

// Sanitize schema: allow KaTeX, highlight.js classes, heading IDs, task list checkboxes.
// hast-util-sanitize's per-tag attribute lists OVERRIDE the `*` wildcard (they
// don't merge), so any tag we want className on needs it listed explicitly.
// `<a>` defaults to allowing only `data-footnote-backref` as a className value;
// we override to allow any class so wiki-link, etc. survive.
const sanitizeSchema: SanitizeSchema = {
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
    // The default schema pins <code> classNames to /^language-./, which would
    // eat the `no-highlight` the mermaid source block carries (see
    // mermaid.ts). Same first-definition-wins rule as <a> above, so our
    // widened copy has to be prepended.
    code: [
      ["className", /^language-./, "no-highlight"],
      ...(defaultSchema.attributes?.["code"] || []),
      "className",
    ],
    // `data-mermaid` marks a diagram the browser still has to draw; the
    // client-side shim selects on `pre[data-mermaid] > code`.
    pre: [...(defaultSchema.attributes?.["pre"] || []), "className", "data-mermaid"],
    math: ["xmlns", "display"],
    ...Object.fromEntries(SVG_TAG_NAMES.map((tagName) => [tagName, SVG_ATTRIBUTES])),
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "math", "mi", "mo", "mn", "ms", "mtext", "mspace", "mover", "munder",
    "munderover", "msub", "msup", "msubsup", "mfrac", "mroot", "msqrt",
    "mtable", "mtr", "mtd", "mrow", "annotation", "semantics",
    "span", "div", "input", "section", "details", "summary",
    "figure", ...SVG_TAG_NAMES, "style",
  ],
  ancestors: {
    ...defaultSchema.ancestors,
    // A diagram's own theme CSS only, never a loose `<style>` in the document:
    // outside an `<svg>` the ancestor check fails and `strip` below takes it
    // away whole.
    style: ["svg"],
  },
  // hast-util-sanitize's default for a disallowed element is to unwrap it and
  // keep the children, which for these would mean CSS text or smuggled HTML
  // landing in the document as content. Drop them whole instead.
  strip: [...(defaultSchema.strip || []), "style", "foreignObject", "desc", "metadata"],
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
    // Before rehype-highlight: the web form relies on the `no-highlight`
    // class it adds being honoured downstream.
    .use(rehypeMermaid, { target: options.target, renderMermaid: options.renderMermaid })
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
 * v8: visitor accepts the placeholder as a separator (v7 only updated
 *     the preprocessor — the regex still required literal `|`, so
 *     wikilinks with display labels were unresolved everywhere in v7).
 * v9: mermaid fences now render as diagrams — `pre[data-mermaid]` on the web
 *     path (drawn client-side), inlined SVG on the pdf path.
 */
export const RENDERER_VERSION = "v9";

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
