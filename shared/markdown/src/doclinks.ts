/**
 * Rehype plugin: resolve relative links between documents.
 *
 * `[setup](./intro.md)` is how one markdown file links to another on disk,
 * on GitHub and in a local editor. Left as written it breaks on Sideways,
 * for the same reason relative images did (see assets.ts): a document's URL
 * has no `.md` and no trailing slash, so the browser resolves `./intro.md`
 * from an `index.md` page one directory too high, and a link to an
 * `index.md` page keeps a filename its URL doesn't have.
 *
 * So each relative `.md` link is resolved against the linking document's
 * stored path and looked up in the space's document list:
 *
 *   found      — the href becomes the document's canonical URL.
 *   not found  — the link becomes an unresolved marker, the way an
 *                unresolved wikilink does, rather than a silent dead link.
 *
 * Unlike asset references this one checks existence, so its output depends
 * on the document list — the same dependency wikilinks have, covered by the
 * same cache invalidation on structural changes.
 */

import { unified } from "unified";
import { visit } from "unist-util-visit";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, Element } from "hast";
import { docUrl, resolveRelativeRef, type RelativeRef } from "@sideways/types";
import type { WikiLinkContext } from "./wikilinks.js";
import { splitRelativeRef, unlink } from "./relative.js";

/**
 * Must match the rehype-sanitize clobberPrefix configured in index.ts.
 * Duplicated rather than imported, as in wikilinks.ts, to keep the deps
 * top-down.
 */
const ID_CLOBBER_PREFIX = "user-content-";

export interface DocLinkOptions {
  /** Same flag as `RenderOptions.target`. */
  target: "web" | "pdf";
  /** The space's documents, and the one being rendered. */
  context?: WikiLinkContext;
  /**
   * Prepended to resolved hrefs, which are otherwise root-relative. On the
   * pdf target, leaving it out turns links to other documents into plain
   * text.
   */
  origin?: string;
}

/**
 * A relative link to a markdown file: where it lands, or null for `ref` if
 * it lands nowhere a document could be (it climbs above the space, say).
 * Undefined when the reference isn't a relative `.md` link at all.
 */
function resolveDocLink(
  href: unknown,
  fromPath: string,
): { ref: RelativeRef | null; suffix: string } | undefined {
  const split = splitRelativeRef(href);
  if (!split || !split.target.endsWith(".md")) return undefined;
  return { ref: resolveRelativeRef(fromPath, split.target), suffix: split.suffix };
}

/**
 * Rewrite a link's trailing `#fragment` to the id the target page gives its
 * heading — the sanitiser prefixes every id — and leave any query alone.
 */
function prefixFragment(suffix: string): string {
  const hash = suffix.indexOf("#");
  if (hash === -1) return suffix;
  const query = suffix.slice(0, hash);
  const fragment = suffix.slice(hash + 1);
  if (!fragment) return query;
  if (fragment.startsWith(ID_CLOBBER_PREFIX)) return suffix;

  // The href reaches us percent-encoded; decode first so it isn't done twice.
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Not valid encoding: take it as written.
  }
  return `${query}#${ID_CLOBBER_PREFIX}${encodeURIComponent(decoded)}`;
}

export function rehypeDocLinks(options: DocLinkOptions) {
  return (tree: Root): undefined => {
    const ctx = options.context;
    const from = ctx?.from;
    if (!ctx || !from) return;

    const selfUrl = docUrl({ spaceSlug: ctx.spaceSlug, sectionSlug: from.sectionSlug, path: from.path });

    /**
     * Point `node` at a document's page: `url` is its root-relative URL and
     * `suffix` any query and (already prefixed) fragment.
     *
     * On the web that is the whole job. A PDF has no site underneath it, so
     * there the link is one of three things:
     *   - to a heading in this same document: the fragment alone, which
     *     works inside the PDF;
     *   - absolute, when the export was given an `origin` to make it so;
     *   - otherwise plain text. Links into the space are opt-in for a PDF.
     */
    const linkTo = (node: Element, url: string, suffix: string) => {
      let href: string | null = url + suffix;
      if (options.target === "pdf") {
        const hash = suffix.indexOf("#");
        if (url === selfUrl && hash !== -1) href = suffix.slice(hash);
        else href = options.origin ? options.origin + url + suffix : null;
      } else if (options.origin) {
        href = options.origin + href;
      }

      if (href === null) unlink(node);
      else node.properties = { ...node.properties, href };
    };

    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;

      // A resolved wikilink already carries its document's root-relative
      // URL. Only a PDF needs anything more done to it.
      if (options.target === "pdf" && typeof href === "string" && href.startsWith("/") && isWikiLink(node)) {
        const cut = href.search(/[?#]/);
        linkTo(node, cut === -1 ? href : href.slice(0, cut), cut === -1 ? "" : href.slice(cut));
        return;
      }

      const link = resolveDocLink(href, from.path);
      if (!link) return;

      const sectionSlug = link.ref?.sectionSlug ?? from.sectionSlug;
      const doc =
        link.ref &&
        ctx.docs.find((d) => d.sectionSlug === sectionSlug && d.path === link.ref!.path);

      if (doc) {
        const url = docUrl({ spaceSlug: ctx.spaceSlug, sectionSlug: doc.sectionSlug, path: doc.path });
        linkTo(node, url, prefixFragment(link.suffix));
        return;
      }

      // No such document. A span, not a link: there is nowhere to go, and
      // following the href as written would land on "Document not found".
      const { href: _href, className, ...rest } = node.properties ?? {};
      node.tagName = "span";
      node.properties = {
        ...rest,
        className: [
          ...(Array.isArray(className) ? className.map(String) : []),
          "doc-link-unresolved",
        ],
      };
    });
  };
}

function isWikiLink(node: Element): boolean {
  const className = node.properties?.className;
  return Array.isArray(className) && className.includes("wiki-link");
}

/** One relative link from a document to another markdown file. */
export interface DocLinkRef {
  /** The link as written, without any query or fragment. */
  href: string;
  /** Where it lands, or null if that is nowhere a document could be. */
  ref: RelativeRef | null;
}

/**
 * The relative `.md` links in a document, each listed once. For the CLI,
 * which can say before a push that a link is going nowhere. Parses, like
 * `extractAssetRefs`, so a link in a code fence doesn't count.
 */
export function extractDocLinks(markdown: string, docPath: string): DocLinkRef[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const links = new Map<string, DocLinkRef>();
  visit(tree, (node) => {
    // `definition` covers reference-style links: `[intro]: ./intro.md`.
    if (node.type !== "link" && node.type !== "definition") return;
    const split = splitRelativeRef(node.url);
    if (!split || links.has(split.target)) return;
    const link = resolveDocLink(node.url, docPath);
    if (link) links.set(split.target, { href: split.target, ref: link.ref });
  });
  return [...links.values()];
}
