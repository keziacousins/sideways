/**
 * Rehype plugin: point relative asset references at the hosted files.
 *
 * `![flow](./img/flow.png)` and `[spec](./spec.pdf)` are written relative to
 * the markdown file, the way they are on disk. The browser cannot be left to
 * resolve them: a document's URL has no `.md` and no trailing slash, and
 * `guides/index.md` is served at `/…/guides`, so `./img/flow.png` there would
 * land one directory too high. This resolves each reference against the
 * document's stored path instead and rewrites it to the asset's own URL.
 *
 * What changes, by target:
 *
 *   web  — `<img src>` becomes the asset URL. A link to a hosted file opens
 *          in a new tab.
 *   pdf  — `<img src>` becomes a `data:` URI from `inlineAsset`, because
 *          WeasyPrint has no way to fetch an access-controlled asset. A link
 *          becomes absolute, so it still leads somewhere from a PDF.
 *
 * Purely syntactic: it never checks that the asset exists, so the cached
 * HTML stays valid when assets are uploaded, replaced or deleted.
 */

import { unified } from "unified";
import { visit } from "unist-util-visit";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, Element } from "hast";
import { assetUrl, assetMimeType, resolveRelativePath } from "@sideways/types";

export interface AssetOptions {
  /** Same flag as `RenderOptions.target`. */
  target: "web" | "pdf";
  /** The document being rendered. Without it nothing can be resolved. */
  from?: { spaceSlug: string; sectionSlug: string; path: string };
  /** Prepended to link hrefs, which are otherwise root-relative. */
  origin?: string;
  /** Section-relative asset path in, `data:` URI out; null if it can't be embedded. */
  inlineAsset?: (path: string) => Promise<string | null>;
}

/**
 * Split a reference into the section-relative path it names and whatever
 * trails it (`?query`, `#fragment` — `spec.pdf#page=3` is worth keeping).
 * Null for anything that isn't a relative path: a scheme (`https:`, `data:`),
 * a host (`//cdn`), a root (`/x`), or a bare fragment.
 */
function resolveRef(
  ref: unknown,
  fromPath: string,
): { path: string; suffix: string } | null {
  if (typeof ref !== "string" || ref === "") return null;
  if (/^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(ref)) return null;

  const cut = ref.search(/[?#]/);
  const target = cut === -1 ? ref : ref.slice(0, cut);
  const path = resolveRelativePath(fromPath, target);
  if (path === null) return null;
  return { path, suffix: cut === -1 ? "" : ref.slice(cut) };
}

/**
 * The hosted files a document references: every relative image or link
 * target of a hosted type, as section-relative paths, each listed once.
 *
 * This is how the CLI decides which files beside a document belong with it.
 * It parses rather than pattern-matches so that it agrees with the renderer
 * below — a reference inside a code fence is not a reference.
 */
export function extractAssetRefs(markdown: string, docPath: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const paths = new Set<string>();
  visit(tree, (node) => {
    // `definition` covers reference-style links: `[spec]: ./spec.pdf`.
    if (node.type !== "image" && node.type !== "link" && node.type !== "definition") return;
    const ref = resolveRef(node.url, docPath);
    if (ref && assetMimeType(ref.path)) paths.add(ref.path);
  });
  return [...paths];
}

/** The classes already on a node. hast holds `className` as a list. */
function classList(node: Element): string[] {
  const value = node.properties?.className;
  return Array.isArray(value) ? value.map(String) : [];
}

export function rehypeAssets(options: AssetOptions) {
  return async (tree: Root): Promise<undefined> => {
    const { from } = options;
    if (!from) return;

    const urlFor = (path: string) =>
      assetUrl({ spaceSlug: from.spaceSlug, sectionSlug: from.sectionSlug, path });

    /** Make `node` a link to a hosted file. */
    const linkTo = (node: Element, path: string, suffix: string) => {
      node.properties = {
        ...node.properties,
        href: (options.origin ?? "") + urlFor(path) + suffix,
        className: [...classList(node), "asset-link"],
        target: "_blank",
        rel: ["noopener"],
      };
    };

    const toInline: Array<{ node: Element; path: string }> = [];

    visit(tree, "element", (node: Element) => {
      if (node.tagName === "a") {
        const ref = resolveRef(node.properties?.href, from.path);
        // Hosted file types only. A relative link to anything else — another
        // document, say — is not an asset reference and is left as written.
        if (!ref || !assetMimeType(ref.path)) return;
        linkTo(node, ref.path, ref.suffix);
        return;
      }

      if (node.tagName !== "img") return;
      const ref = resolveRef(node.properties?.src, from.path);
      if (!ref) return;

      // `![spec](./spec.pdf)` — image syntax around something that isn't an
      // image. Draw it as the link the author presumably wanted, rather than
      // as a broken picture.
      if (assetMimeType(ref.path) === "application/pdf") {
        const alt = node.properties?.alt;
        const label = typeof alt === "string" && alt ? alt : ref.path.split("/").pop()!;
        node.tagName = "a";
        node.properties = {};
        node.children = [{ type: "text", value: label }];
        linkTo(node, ref.path, ref.suffix);
        return;
      }

      if (options.target === "pdf") {
        toInline.push({ node, path: ref.path });
      } else {
        node.properties = { ...node.properties, src: urlFor(ref.path) + ref.suffix };
      }
    });

    await Promise.all(
      toInline.map(async ({ node, path }) => {
        const data = (await options.inlineAsset?.(path)) ?? null;
        const { src: _src, ...rest } = node.properties ?? {};
        // With no `src` WeasyPrint prints the alt text, which is the honest
        // rendering of an image that could not be embedded.
        node.properties = data ? { ...rest, src: data } : rest;
      }),
    );
  };
}
