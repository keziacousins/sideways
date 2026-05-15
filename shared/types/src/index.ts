/** Visibility levels */
export type Visibility = "private" | "shared" | "org" | "public";

/** A space is a top-level container: project, team, or personal area */
export interface Space {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  ownerId: string;
  themeId: string | null;
  personal: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A section is a navigation/organisation node within a space (no content) */
export interface Section {
  id: string;
  spaceId: string;
  parentId: string | null;
  slug: string;
  title: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** A document within a space */
export interface Document {
  id: string;
  spaceId: string;
  sectionId: string;
  parentId: string | null;
  /** Filesystem-shaped path within the section, e.g. "architecture/overview.md". */
  path: string;
  title: string;
  position: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** A specific version of a document */
export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  title: string;
  content: string;
  contentHash: string;
  renderedKey: string | null;
  createdBy: string;
  createdAt: string;
}

/** A comment on a document */
export interface Comment {
  id: string;
  documentId: string;
  versionId: string | null;
  parentId: string | null;
  authorId: string;
  body: string;
  /** Text snippet the comment is anchored to. Null = page-level comment. */
  anchorText: string | null;
  /** Heading hierarchy at anchor point */
  anchorSection: string | null;
  /** Surrounding lines for context */
  anchorContext: string | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A theme bundle */
export interface Theme {
  id: string;
  name: string;
  orgId: string | null;
  tokens: Record<string, string>;
  logoAssets: string[];
  fonts: string[];
  createdAt: string;
  updatedAt: string;
}

/** An uploaded asset */
export interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  storageKey: string;
  ownerId: string;
  spaceId: string | null;
  documentId: string | null;
  createdAt: string;
}

/** Space membership */
export interface SpaceMember {
  id: string;
  spaceId: string;
  userId: string;
  role: "viewer" | "editor" | "admin";
  createdAt: string;
}

/** Reference to a document by its URL-shaping fields. */
export interface DocRef {
  spaceSlug: string;
  sectionSlug: string;
  /** Filesystem-shaped path within the section, e.g. "architecture/overview.md". */
  path: string;
}

/**
 * Build the canonical web URL for a document.
 *
 * Format: `/s/<space>/<section>/<...path>` with `.md` stripped and
 * `index.md` collapsed to its containing directory (so a section's
 * `index.md` lives at `/s/<space>/<section>` itself).
 */
export function docUrl(ref: DocRef): string {
  const space = encodeURIComponent(ref.spaceSlug);
  const section = encodeURIComponent(ref.sectionSlug);

  const trimmed = ref.path
    .replace(/\.md$/, "")
    .replace(/(^|\/)index$/, "");

  if (!trimmed) return `/s/${space}/${section}`;

  const segments = trimmed.split("/").map(encodeURIComponent).join("/");
  return `/s/${space}/${section}/${segments}`;
}
