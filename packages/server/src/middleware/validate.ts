/**
 * Input validation helpers for API routes.
 */

export const LIMITS = {
  title: 500,
  slug: 200,
  tag: 100,
  tags: 50,        // max number of tags
  content: 500_000, // ~500KB markdown
  comment: 10_000,
  name: 200,
  description: 2000,
} as const;

export function validateTitle(title: string): string | null {
  if (title.length > LIMITS.title) return `Title must be under ${LIMITS.title} characters`;
  return null;
}

export function validateSlug(slug: string): string | null {
  if (slug.length > LIMITS.slug) return `Slug must be under ${LIMITS.slug} characters`;
  if (!/^[a-z0-9-]+$/.test(slug)) return "Slug must contain only lowercase letters, numbers, and hyphens";
  return null;
}

/**
 * Validate a document path. Filesystem-shaped: forward-slash-separated
 * segments, each segment matches `[A-Za-z0-9._-]+`, no `..`, no leading/
 * trailing slash, must end in `.md`. Tighter than a generic file path —
 * we own the layout and want predictable, URL-safe characters.
 */
export function validatePath(path: string): string | null {
  if (!path) return "Path is required";
  if (path.length > LIMITS.slug * 4) return `Path is too long`;
  if (!path.endsWith(".md")) return "Path must end in .md";
  if (path.startsWith("/") || path.endsWith("/")) return "Path cannot have leading or trailing slash";
  const segments = path.split("/");
  for (const seg of segments) {
    if (!seg) return "Path cannot contain empty segments";
    if (seg === "." || seg === "..") return "Path cannot contain . or .. segments";
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) return `Path segment "${seg}" contains invalid characters`;
  }
  return null;
}

export function validateTags(tags: string[]): string | null {
  if (tags.length > LIMITS.tags) return `Maximum ${LIMITS.tags} tags`;
  for (const tag of tags) {
    if (tag.length > LIMITS.tag) return `Tag "${tag.slice(0, 20)}..." exceeds ${LIMITS.tag} characters`;
  }
  return null;
}

export function validateContent(content: string): string | null {
  if (content.length > LIMITS.content) return `Content exceeds ${LIMITS.content} character limit`;
  return null;
}
