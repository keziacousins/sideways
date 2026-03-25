/** Visibility levels for documents */
export type Visibility = "private" | "shared" | "org" | "public";

/** A document in the system */
export interface Document {
  id: string;
  slug: string;
  title: string;
  content: string;
  visibility: Visibility;
  ownerId: string;
  parentId: string | null;
  position: number;
  tags: string[];
  themeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A specific version of a document */
export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  content: string;
  title: string;
  createdAt: string;
  createdBy: string;
}

/** A comment on a document */
export interface Comment {
  id: string;
  documentId: string;
  versionId: string | null;
  parentId: string | null;
  authorId: string;
  body: string;
  /** For inline comments: character offset range in the document */
  anchorStart: number | null;
  anchorEnd: number | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A theme bundle */
export interface Theme {
  id: string;
  name: string;
  orgId: string;
  /** Design tokens (colors, spacing, fonts) */
  tokens: Record<string, string>;
  /** SeaweedFS references for logo assets */
  logoAssets: string[];
  /** Google Font family names — font files stored in SeaweedFS */
  fonts: string[];
  createdAt: string;
  updatedAt: string;
}

/** An uploaded asset (image, file, font, etc.) */
export interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  /** SeaweedFS file ID */
  storageKey: string;
  ownerId: string;
  documentId: string | null;
  createdAt: string;
}
