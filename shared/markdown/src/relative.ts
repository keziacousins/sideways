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
