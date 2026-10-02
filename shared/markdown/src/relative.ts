import type { Element } from "hast";

/**
 * Split a relative reference into its path and whatever trails it (`?query`,
 * `#fragment`). Null for anything that isn't a relative path: a scheme
 * (`https:`, `data:`), a host (`//cdn`), a root (`/x`), or a bare fragment.
 *
 * Shared by the asset and document-link resolvers, so they agree on what
 * "relative" means.
 */
export function splitRelativeRef(ref: unknown): { target: string; suffix: string } | null {
  if (typeof ref !== "string" || ref === "") return null;
  if (/^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(ref)) return null;

  const cut = ref.search(/[?#]/);
  return cut === -1
    ? { target: ref, suffix: "" }
    : { target: ref.slice(0, cut), suffix: ref.slice(cut) };
}

/**
 * Turn a link into plain text: same content, nothing to follow. Used in a PDF
 * export for links into the space when the export wasn't asked to carry them
 * — a PDF is the thing that gets sent outside, and a link back into the
 * instance is a login wall for whoever receives it.
 */
export function unlink(node: Element): void {
  node.tagName = "span";
  node.properties = {};
}
