/**
 * Remark plugin: transforms `[[target]]` and `[[target|display]]` into links.
 *
 * Resolution rules (see PROPOSAL-phase-3-path-as-url.md "Wikilinks"):
 *
 *   1. Relative — `./sibling`, `../up/over` — resolved against the linking
 *      doc's directory within its section.
 *   2. Path-qualified — contains `/`, no `./` prefix — exact section-relative
 *      path lookup within the linking doc's section.
 *   3. Bare basename — single segment, no slash — try, in order:
 *        a. same dir as the linking doc, exact basename match
 *        b. same section, unique basename match
 *        c. section root: target matches a section slug whose section has an
 *           index doc
 *        d. space-wide, unique basename match
 *
 * Anything else renders as an unresolved span (no link emitted), with class
 * `wiki-link-unresolved` for "no match" and `wiki-link-ambiguous` for
 * "multiple matches at the same precedence layer."
 */

import { visit } from "unist-util-visit";
import type { Root, Text } from "mdast";
import { docUrl, type DocRef } from "@sideways/types";

const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

/**
 * Pre-escape `|` inside `[[…]]` on the raw source so GFM table parsing
 * doesn't shred the wikilink across cells. CommonMark unescapes `\|` back
 * to `|` in the text it emits, so by the time the visitor below runs the
 * text node contains `[[target|display]]` again and matches WIKI_LINK_RE
 * normally.
 *
 * Code-fence-aware: never mutates content inside ```/~~~ blocks, so
 * wikilink-shaped sample text in code stays verbatim. Doesn't guard against
 * inline code spans (single backticks) — wikilink syntax inside inline
 * code is rare, and the worst case is a stray `\\|` showing up in code.
 */
export function escapeWikiLinkPipes(md: string): string {
  const lines = md.split("\n");
  let fence: "`" | "~" | null = null;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0] as "`" | "~";
        if (fence === null) {
          fence = marker;
          return line;
        }
        if (fence === marker) {
          fence = null;
          return line;
        }
      }
      if (fence !== null) return line;

      return line.replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner) =>
        `[[${inner.replace(/\|/g, "\\|")}]]`,
      );
    })
    .join("\n");
}

/**
 * Must match the rehype-sanitize clobberPrefix configured in index.ts.
 * Duplicated rather than imported so the deps stay top-down (index imports
 * wikilinks, not the other way round) and we don't risk a circular load.
 */
const ID_CLOBBER_PREFIX = "user-content-";

/**
 * Split a wiki-link target into its doc-reference half and an optional
 * in-doc fragment. `[[foo#bar]]` → `{ ref: "foo", fragment: "bar" }`.
 * `[[#bar]]` → same-doc anchor with `ref: ""`. The fragment is URL-safe
 * and gets the DOM-clobber prefix prepended so it lines up with the
 * rendered heading ids on the target page.
 */
function splitTarget(raw: string): { ref: string; fragmentSuffix: string } {
  const hashIdx = raw.indexOf("#");
  if (hashIdx === -1) return { ref: raw, fragmentSuffix: "" };
  const ref = raw.slice(0, hashIdx);
  const fragment = raw.slice(hashIdx + 1).trim();
  if (!fragment) return { ref, fragmentSuffix: "" };
  return { ref, fragmentSuffix: `#${ID_CLOBBER_PREFIX}${encodeURIComponent(fragment)}` };
}

export interface WikiLinkDoc {
  sectionSlug: string;
  /** Filesystem-shaped path within the section, e.g. "architecture/overview.md". */
  path: string;
  title: string;
}

export interface WikiLinkSection {
  slug: string;
  /** Whether this section has an `index.md` doc — required for `[[section]]` resolution. */
  hasIndex: boolean;
}

export interface WikiLinkContext {
  spaceSlug: string;
  docs: WikiLinkDoc[];
  sections: WikiLinkSection[];
  /** The doc being rendered, for relative + same-dir resolution. */
  from?: { sectionSlug: string; path: string };
}

type Resolution =
  | { kind: "resolved"; href: string }
  | { kind: "unresolved" }
  | { kind: "ambiguous" };

export function remarkWikiLinks(ctx?: WikiLinkContext) {
  return () => (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      const text = node.value;
      if (!text.includes("[[")) return;

      const children: any[] = [];
      let lastIdx = 0;

      for (const match of text.matchAll(WIKI_LINK_RE)) {
        const [full, rawTarget, rawDisplay] = match;
        const matchIdx = match.index!;

        if (matchIdx > lastIdx) {
          children.push({ type: "text", value: text.slice(lastIdx, matchIdx) });
        }

        const { ref, fragmentSuffix } = splitTarget(rawTarget.trim());
        const display = (rawDisplay || rawTarget).trim();
        const resolution = resolve(ref, ctx, fragmentSuffix);

        children.push(buildNode(resolution, display));
        lastIdx = matchIdx + full.length;
      }

      if (lastIdx < text.length) {
        children.push({ type: "text", value: text.slice(lastIdx) });
      }

      if (children.length > 0) {
        parent.children.splice(index, 1, ...children);
      }
    });
  };
}

function buildNode(res: Resolution, label: string): any {
  if (res.kind === "resolved") {
    return {
      type: "link",
      url: res.href,
      children: [{ type: "text", value: label }],
      data: { hProperties: { className: ["wiki-link"] } },
    };
  }
  // Unresolved or ambiguous: render as <span> via mdast-util-to-hast's hName
  // override on a `link` node (we keep `link`'s url empty so nothing tries
  // to treat it as a hyperlink). Sanitiser keeps span+className.
  const className =
    res.kind === "ambiguous"
      ? ["wiki-link", "wiki-link-ambiguous"]
      : ["wiki-link", "wiki-link-unresolved"];
  return {
    type: "link",
    url: "",
    children: [{ type: "text", value: label }],
    data: { hName: "span", hProperties: { className } },
  };
}

function resolve(
  target: string,
  ctx?: WikiLinkContext,
  fragmentSuffix: string = "",
): Resolution {
  // Same-doc anchor: `[[#bar]]` resolves to the current page's prefixed
  // fragment. No doc lookup needed.
  if (target === "" && fragmentSuffix !== "") {
    return { kind: "resolved", href: fragmentSuffix };
  }
  if (!ctx) return { kind: "unresolved" };

  const linkTo = (doc: WikiLinkDoc): Resolution => ({
    kind: "resolved",
    href:
      docUrl({ spaceSlug: ctx.spaceSlug, sectionSlug: doc.sectionSlug, path: doc.path }) +
      fragmentSuffix,
  });

  // 1. Relative
  if (target.startsWith("./") || target.startsWith("../")) {
    if (!ctx.from) return { kind: "unresolved" };
    const resolved = resolveRelative(ctx.from.path, target);
    if (resolved === null) return { kind: "unresolved" };
    const match = ctx.docs.find(
      (d) => d.sectionSlug === ctx.from!.sectionSlug && stripMd(d.path) === resolved,
    );
    return match ? linkTo(match) : { kind: "unresolved" };
  }

  // 2. Path-qualified (section-relative)
  if (target.includes("/")) {
    if (!ctx.from) return { kind: "unresolved" };
    const match = ctx.docs.find(
      (d) => d.sectionSlug === ctx.from!.sectionSlug && stripMd(d.path) === target,
    );
    return match ? linkTo(match) : { kind: "unresolved" };
  }

  // 3. Bare basename — precedence:

  // 3a. Same dir, exact basename match
  if (ctx.from) {
    const dir = dirname(ctx.from.path);
    const sameDir = ctx.docs.filter(
      (d) =>
        d.sectionSlug === ctx.from!.sectionSlug &&
        dirname(d.path) === dir &&
        basename(d.path) === target,
    );
    if (sameDir.length === 1) return linkTo(sameDir[0]);
    // Within a single dir, basename uniqueness is enforced by the path
    // unique constraint, so >1 shouldn't happen.
  }

  // 3b. Same section, unique basename
  if (ctx.from) {
    const sameSection = ctx.docs.filter(
      (d) => d.sectionSlug === ctx.from!.sectionSlug && basename(d.path) === target,
    );
    if (sameSection.length === 1) return linkTo(sameSection[0]);
    // If >1, fall through to section-root and space-wide.
  }

  // 3c. Section root: target matches a section slug with an index doc
  const section = ctx.sections.find((s) => s.slug === target && s.hasIndex);
  if (section) {
    const ref: DocRef = {
      spaceSlug: ctx.spaceSlug,
      sectionSlug: section.slug,
      path: "index.md",
    };
    return { kind: "resolved", href: docUrl(ref) + fragmentSuffix };
  }

  // 3d. Space-wide, unique basename
  const spaceWide = ctx.docs.filter((d) => basename(d.path) === target);
  if (spaceWide.length === 1) return linkTo(spaceWide[0]);
  if (spaceWide.length > 1) return { kind: "ambiguous" };

  return { kind: "unresolved" };
}

function stripMd(path: string): string {
  return path.replace(/\.md$/, "");
}

function basename(path: string): string {
  const name = path.split("/").pop() ?? "";
  return stripMd(name);
}

function dirname(path: string): string {
  const segs = path.split("/");
  segs.pop();
  return segs.join("/");
}

/**
 * Resolve `target` (a `./` or `../` form) relative to the directory of
 * `from`. Returns the section-relative path with `.md` already stripped.
 * Returns null if the target escapes the section root.
 */
function resolveRelative(fromPath: string, target: string): string | null {
  const segs = fromPath.split("/");
  segs.pop(); // drop the file
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length === 0) return null;
      segs.pop();
    } else {
      segs.push(seg);
    }
  }
  return stripMd(segs.join("/"));
}

