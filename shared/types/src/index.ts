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

/** A file hosted beside the documents: an image, or a PDF a document links to. */
export interface Asset {
  id: string;
  spaceId: string;
  sectionId: string;
  /** Filesystem-shaped path within the section, e.g. "guides/img/flow.png". */
  path: string;
  mimeType: string;
  size: number;
  /** SHA-256 of the bytes, hex. */
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

/** Space membership */
export interface SpaceMember {
  id: string;
  spaceId: string;
  userId: string;
  role: "viewer" | "editor" | "admin";
  createdAt: string;
}

export type SpaceEventType =
  | "doc_created"
  | "doc_edited"
  | "doc_deleted"
  | "doc_renamed"
  | "doc_moved"
  | "doc_moved_out"
  | "doc_moved_in"
  | "comment_created";

/** One entry in a space's activity log, as the API returns it */
export interface SpaceEvent {
  id: string;
  type: SpaceEventType;
  actorId: string | null;
  actorName: string;
  /** Kept after the document is deleted, so its events still group together. */
  documentId: string | null;
  /** Document title when the event happened. */
  title: string;
  /** Where the document (or comment) is now; null once it is gone from this space. */
  url: string | null;
  /** Old and new title for a rename; old and new `section/path` for a move. */
  detail: { from: string; to: string } | null;
  /** Plain-text start of the comment as it reads now; null if it was deleted. */
  snippet: string | null;
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

/**
 * File types Sideways hosts as assets, by extension. The extension is part of
 * the contract: an upload is accepted only when its bytes are of the type its
 * extension names, so the renderer can decide image-or-link from the path
 * alone.
 */
export const ASSET_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** MIME type an asset path's extension names, or null if it isn't a hosted type. */
export function assetMimeType(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return ASSET_MIME_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Build the web URL an asset is served from.
 *
 * Format: `/a/<space>/<section>/<...path>`, extension kept. A separate prefix
 * from `/s/` so an asset path can never shadow a document's URL.
 */
export function assetUrl(ref: DocRef): string {
  const space = encodeURIComponent(ref.spaceSlug);
  const section = encodeURIComponent(ref.sectionSlug);
  const segments = ref.path.split("/").map(encodeURIComponent).join("/");
  return `/a/${space}/${section}/${segments}`;
}

/** Where a relative reference lands within a space. */
export interface RelativeRef {
  /** The section it lands in; null for the linking document's own. */
  sectionSlug: string | null;
  /** Path within that section. */
  path: string;
}

/**
 * Resolve a relative reference written in a document (`./intro.md`,
 * `img/a.png`, `../shared/a.png`) the way a filesystem would from the
 * document's directory.
 *
 * `target` is the path part of the reference only, with no query or fragment,
 * and may be percent-encoded.
 *
 * A reference may climb one level above the section root, and the segment it
 * names there is taken as a section slug: `../../platform/api.md` from
 * `guides/auth.md` is `api.md` in section `platform`. The server knows
 * sections, not the directories they are mounted from, so this is right
 * exactly when each section is mounted from a sibling directory named after
 * its slug — the usual layout.
 *
 * Returns null when the reference isn't relative (a leading `/`), is
 * malformed, names a directory, or climbs above the space.
 */
export function resolveRelativeRef(fromDocPath: string, target: string): RelativeRef | null {
  if (!target || target.startsWith("/")) return null;

  const segs = fromDocPath.split("/");
  segs.pop(); // drop the file

  let sectionSlug: string | null = null;
  // True once the reference has climbed above the section root; the next
  // name it gives is a section, and `segs` is empty until then.
  let aboveSection = false;
  // False while the reference still ends on a directory (`./`, `..`, `img/`).
  let endsOnFile = false;

  for (const raw of target.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    endsOnFile = false;
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (aboveSection) return null;
      if (segs.length === 0) aboveSection = true;
      else segs.pop();
    } else {
      // An encoded slash would smuggle in a segment boundary.
      if (seg.includes("/")) return null;
      if (aboveSection) {
        sectionSlug = seg;
        aboveSection = false;
      } else {
        segs.push(seg);
        endsOnFile = true;
      }
    }
  }

  return endsOnFile ? { sectionSlug, path: segs.join("/") } : null;
}

/**
 * `resolveRelativeRef` for references that have to stay in the linking
 * document's section, as assets do. Returns the section-relative path, or
 * null if the reference leaves the section.
 */
export function resolveRelativePath(fromDocPath: string, target: string): string | null {
  const ref = resolveRelativeRef(fromDocPath, target);
  return ref && ref.sectionSlug === null ? ref.path : null;
}
