/**
 * Rehype plugin: mermaid diagrams (see issue #47).
 *
 * Laying a diagram out needs a JS runtime. The browser has one, WeasyPrint
 * does not, so the two surfaces are served differently and the split is keyed
 * on `RenderOptions.target`:
 *
 *   - web — the fenced block stays put as source, tagged `data-mermaid`, and
 *     the viewer's client-side shim (which looks for `pre[data-mermaid] >
 *     code` and reads its `textContent`) draws it after load.
 *   - pdf — `renderMermaid` hands the source to the headless-browser sidecar
 *     and we inline the SVG it returns, because nothing in the PDF pipeline
 *     will ever run that shim.
 *
 * Must run BEFORE rehype-highlight. On the web path the source has to reach
 * the browser verbatim, which is what the `no-highlight` class added here
 * buys us — but only if highlight is still downstream to see it.
 *
 * A diagram is never allowed to take the surrounding document down with it:
 * a rejecting `renderMermaid` degrades to the web form plus a visible note.
 */

import { SKIP, visit } from "unist-util-visit";
import { fromHtml } from "hast-util-from-html";
import type { Element, ElementContent, Parent, Root, RootContent, Text } from "hast";

const MERMAID_LANGUAGE_CLASS = "language-mermaid";

// Local copy of index.ts's ID_CLOBBER_PREFIX (wikilinks.ts keeps one too) —
// importing it from index.ts would make the module graph circular.
const ID_CLOBBER_PREFIX = "user-content-";

// `url(#arrow)`, `url('#arrow')`, `url( #arrow )` — the SVG-internal
// reference syntax used by marker-end, clip-path, fill, mask and filter.
const URL_REFERENCE_RE = /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g;

const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

// Vetoes a CSS rule outright: a `url()` pointing at anything but a local '#'
// fragment (WeasyPrint would fetch it while printing), or a `<` or `{` — the
// two characters that can end the `<style>` element early or open a block we
// didn't parse (see `rewriteEmbeddedCss`).
const UNSAFE_CSS_RE = /url\s*\(\s*['"]?\s*[^#'"\s]|[<{]/;

export interface MermaidOptions {
  /** Same flag as `RenderOptions.target`; decides which form we emit. */
  target: "web" | "pdf";
  /** Resolves to an SVG string, rejects on failure. Absent on the web path. */
  renderMermaid?: (code: string) => Promise<string>;
}

/**
 * unified transformer. Async — unified awaits transformers that return a
 * promise, and `renderMarkdown` is already async, so no caller changes.
 */
export function rehypeMermaid(options: MermaidOptions) {
  return async (tree: Root): Promise<undefined> => {
    const found: Array<{ parent: Parent; index: number; source: string }> = [];

    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "pre" || !parent || index === undefined) return;
      const source = mermaidSource(node);
      if (source === undefined) return;
      found.push({ parent, index, source });
    });

    // Back to front: a replacement can expand into two siblings (fallback
    // block + error note), which would shift the indexes still to come.
    for (const { parent, index, source } of found.reverse()) {
      parent.children.splice(index, 1, ...(await replacement(source, options)));
    }
  };
}

/**
 * The diagram source of a ```mermaid fence, or undefined if `pre` is any
 * other code block. remark-rehype renders fences as `pre > code.language-x`.
 */
function mermaidSource(pre: Element): string | undefined {
  const code = pre.children.find((child): child is Element => child.type === "element");
  if (!code || code.tagName !== "code") return undefined;

  const classes = code.properties?.className;
  if (!Array.isArray(classes) || !classes.includes(MERMAID_LANGUAGE_CLASS)) return undefined;

  return code.children
    .filter((child): child is Text => child.type === "text")
    .map((child) => child.value)
    .join("");
}

async function replacement(source: string, options: MermaidOptions): Promise<RootContent[]> {
  if (options.target !== "pdf" || !options.renderMermaid) return [sourceBlock(source)];

  try {
    return [diagramFigure(await options.renderMermaid(source))];
  } catch (error) {
    // Broken diagram, sidecar down, sidecar timeout — all the same to us.
    // Show the source (the web form is already the right shape for that)
    // and say why, rather than failing the whole document render.
    const message = error instanceof Error ? error.message : String(error);
    return [sourceBlock(source), errorNote(message)];
  }
}

/**
 * The web form: source text, untouched, for the browser to pick up.
 */
function sourceBlock(source: string): Element {
  return {
    type: "element",
    tagName: "pre",
    properties: { className: ["mermaid-diagram"], "data-mermaid": true },
    children: [
      {
        type: "element",
        tagName: "code",
        properties: { className: [MERMAID_LANGUAGE_CLASS, "no-highlight"] },
        children: [{ type: "text", value: source }],
      },
    ],
  };
}

/**
 * The pdf form: the sidecar's SVG, parsed into hast so rehype-sanitize can
 * vet it element by element. Parsing rather than emitting a `raw` node is the
 * whole point — raw markup would either be dropped or would bypass the
 * sanitiser, and mermaid SVG is attacker-influenced (it embeds diagram
 * labels) markup we do not want to trust.
 */
function diagramFigure(svg: string): Element {
  const figure: Element = {
    type: "element",
    tagName: "figure",
    properties: { className: ["mermaid-diagram"] },
    children: fromHtml(svg, { fragment: true }).children as ElementContent[],
  };
  prefixInternalReferences(figure);
  rewriteEmbeddedCss(figure);
  normaliseSize(figure);
  return figure;
}

/**
 * Pin the diagram to its natural size so it is only ever scaled DOWN.
 *
 * Mermaid emits `width="100%"` plus an inline `max-width` holding the real
 * width. WeasyPrint takes the attribute and ignores the declaration, so a
 * 240pt diagram is stretched across the full content column and every label
 * inside it grows with the viewBox — hence comically large text on simple
 * diagrams, and a trivial flowchart tall enough to displace itself onto the
 * next page and leave the rest of the previous one blank.
 *
 * So we drop `width="100%"`, drop the `max-width` declaration that was
 * standing in for it, and set the intrinsic width/height from the viewBox.
 * The stylesheets then apply `max-width: 100%; height: auto`, which shrinks
 * an oversized diagram to fit and leaves everything else alone.
 *
 * Done here rather than with mermaid's own `useMaxWidth: false` because that
 * flag is read per diagram type (`config.kanban.useMaxWidth`,
 * `config.mindmap.useMaxWidth`, …), so configuring it means enumerating every
 * type mermaid ships and silently missing any type added later. The viewBox
 * is universal.
 */
function normaliseSize(figure: Element): void {
  visit(figure, "element", (node: Element) => {
    // Not SKIP: that would skip the node's children too, and the first node
    // visited is the <figure> wrapping the diagram.
    if (node.tagName !== "svg" || !node.properties) return;

    const box = viewBoxSize(node.properties.viewBox);
    if (!box) return SKIP;

    node.properties.width = box.width;
    node.properties.height = box.height;

    const style = stripMaxWidth(node.properties.style);
    if (style) node.properties.style = style;
    else delete node.properties.style;

    return SKIP;
  });
}

/** `"0 0 239.45 339.36"` -> `{width: 239.45, height: 339.36}`; undefined if unusable. */
function viewBoxSize(viewBox: unknown): { width: number; height: number } | undefined {
  if (typeof viewBox !== "string") return undefined;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [, , width, height] = parts;
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/**
 * Remove `max-width` from an inline style, keeping every other declaration.
 * Mermaid's is the width we just moved onto the attribute; leaving it would
 * re-cap a diagram that the stylesheet is trying to scale down.
 */
function stripMaxWidth(style: unknown): string | undefined {
  if (typeof style !== "string") return undefined;
  const kept = style
    .split(";")
    .filter((d) => d.trim() && !/^\s*max-width\s*:/i.test(d))
    .map((d) => d.trim());
  return kept.length ? `${kept.join("; ")};` : undefined;
}

/**
 * Pre-prefix SVG-internal references so they still resolve after sanitising.
 *
 * hast-util-sanitize rewrites every `id` to `user-content-<id>` as DOM-clobber
 * defence, but leaves the things that point at those ids alone — arrowheads
 * (`marker-end="url(#arrow)"`), clip paths and `<use href="#node">` would all
 * dangle. So we rename the references up front, before sanitise renames their
 * targets. Same trick `rehypePrefixAnchorHrefs` plays for heading anchors.
 */
function prefixInternalReferences(figure: Element): void {
  visit(figure, "element", (node: Element) => {
    if (!node.properties) return;
    for (const [key, value] of Object.entries(node.properties)) {
      if (typeof value !== "string") continue;
      if ((key === "href" || key === "xLinkHref") && value.startsWith("#")) {
        node.properties[key] = `#${ID_CLOBBER_PREFIX}${value.slice(1)}`;
        continue;
      }
      node.properties[key] = value.replace(URL_REFERENCE_RE, urlReference);
    }
  });
}

/** `URL_REFERENCE_RE` replacer: `url(#arrow)` -> `url(#user-content-arrow)`. */
function urlReference(_match: string, quote: string, id: string): string {
  return `url(${quote}#${ID_CLOBBER_PREFIX}${id}${quote})`;
}

/**
 * Rewrite the diagram's own `<style>` block so it survives sanitising.
 *
 * mermaid keeps node fill, edge `fill:none`, stroke and label colour in a
 * `<style>` element inside the `<svg>` — the shapes themselves carry almost
 * no presentation attributes — so a dropped style block prints as solid black
 * boxes with invisible labels. It has to come through. But it is also the one
 * place in the SVG where the document author has a lever: `themeCSS` isn't on
 * mermaid's `secure` list, so `%%{init:{"themeCSS":"…"}}%%` in the fence puts
 * author text in here. So we keep only what mermaid is supposed to emit:
 *
 *   - rules scoped to this diagram's own id, which is all stylis produces for
 *     the `#<svg-id>{…}` wrapper mermaid compiles the theme through. Anything
 *     unscoped — an author who closed that wrapper early with a stray `}`, an
 *     `@import`, a bare `body{…}` — is dropped, so the CSS can never reach
 *     the rest of the printed document.
 *   - no `url()` other than a local '#' fragment, matching the rule the
 *     sanitiser applies to href/xlink:href.
 *   - no `<`: `<style>` serialises as raw text, so a `</style>` in there
 *     would end the element and drop the remainder into the document as HTML.
 *
 * The `#<svg-id>` prefix is rewritten to the clobber-prefixed id for the same
 * reason `prefixInternalReferences` rewrites `url(#…)`: the sanitiser renames
 * the id afterwards and the selectors have to follow it.
 */
function rewriteEmbeddedCss(figure: Element): void {
  visit(figure, "element", (node: Element) => {
    if (node.tagName !== "svg") return;

    const svgId = typeof node.properties?.id === "string" ? node.properties.id : "";
    const styles: Array<{ parent: Parent; index: number; style: Element }> = [];
    visit(node, "element", (style: Element, index, parent) => {
      if (style.tagName !== "style" || !parent || index === undefined) return;
      styles.push({ parent, index, style });
    });

    // Back to front again: dropping one shifts the indexes after it.
    for (const { parent, index, style } of styles.reverse()) {
      // Nothing to scope the rules to means nothing we can safely keep.
      const css = svgId ? scopedCss(styleText(style), svgId) : "";
      if (!css) {
        parent.children.splice(index, 1);
        continue;
      }
      style.properties = {};
      style.children = [{ type: "text", value: css }];
    }

    // The walk above already covered the whole subtree, so don't descend into
    // a nested `<svg>` and rewrite its styles a second time.
    return SKIP;
  });
}

function styleText(style: Element): string {
  return style.children
    .filter((child): child is Text => child.type === "text")
    .map((child) => child.value)
    .join("");
}

/**
 * The subset of `css` that is scoped to `#<svgId>`, with that prefix renamed
 * to the clobber-prefixed id the sanitiser is about to give the element.
 */
function scopedCss(css: string, svgId: string): string {
  const scope = `#${svgId}`;
  const prefixed = `#${ID_CLOBBER_PREFIX}${svgId}`;
  const kept: string[] = [];

  for (const { selector, body } of cssRules(css.replace(CSS_COMMENT_RE, ""))) {
    if (UNSAFE_CSS_RE.test(selector) || UNSAFE_CSS_RE.test(body)) continue;

    const selectors = selector.split(",").map((one) => one.trim());
    if (!selectors.every((one) => isScopedTo(one, scope))) continue;

    const rescoped = selectors.map((one) => prefixed + one.slice(scope.length)).join(",");
    kept.push(`${rescoped}{${body.replace(URL_REFERENCE_RE, urlReference).trim()}}`);
  }

  return kept.join("\n");
}

/**
 * Split CSS into top-level `selector { body }` rules. Not a CSS parser — it
 * only counts braces, which is enough to decide what to keep, because
 * anything with a shape it doesn't understand (a nested block, an at-rule)
 * fails the scope or safety check afterwards anyway.
 */
function cssRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = -1;

  for (let index = 0; index < css.length; index++) {
    const char = css[index];
    if (char === "{") {
      if (depth === 0) bodyStart = index;
      depth++;
    } else if (char === "}") {
      // A stray close brace — an author trying to escape mermaid's wrapper.
      // Whatever follows starts a new (unscoped, so doomed) rule.
      if (depth === 0) {
        selectorStart = index + 1;
        continue;
      }
      depth--;
      if (depth > 0) continue;
      rules.push({
        selector: css.slice(selectorStart, bodyStart),
        body: css.slice(bodyStart + 1, index),
      });
      selectorStart = index + 1;
      bodyStart = -1;
    }
  }

  return rules;
}

/** True if `selector` targets `scope` itself or something inside it. */
function isScopedTo(selector: string, scope: string): boolean {
  if (!selector.startsWith(scope)) return false;
  // `#d1x` and `#d1-note` are other elements' ids, not ours.
  const next = selector.charAt(scope.length);
  return next === "" || !/[\w-]/.test(next);
}

function errorNote(message: string): Element {
  return {
    type: "element",
    tagName: "p",
    properties: { className: ["mermaid-error"] },
    children: [{ type: "text", value: `Diagram failed to render: ${message}` }],
  };
}
