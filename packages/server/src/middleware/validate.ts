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
