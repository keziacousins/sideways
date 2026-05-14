import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

/** Custom tsvector type for Postgres full-text search */
const tsvector = customType<{ data: string }>({
  dataType() { return "tsvector"; },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  hydraSubject: text("hydra_subject").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("users_email_idx").on(t.email),
]);

/** A space is a top-level container: project, team, or personal area */
export const spaces = pgTable("spaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  visibility: text("visibility", {
    enum: ["private", "shared", "org", "public"],
  }).notNull().default("private"),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  themeId: uuid("theme_id").references(() => themes.id),
  /** True for auto-created personal "My Documents" spaces */
  personal: boolean("personal").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("spaces_slug_idx").on(t.slug),
  index("spaces_owner_idx").on(t.ownerId),
]);

/** Sections are navigation/organisation nodes within a space (no content) */
export const sections = pgTable("sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): any => sections.id),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("sections_space_slug_idx").on(t.spaceId, t.slug),
  index("sections_parent_idx").on(t.parentId),
]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  sectionId: uuid("section_id").notNull().references(() => sections.id, { onDelete: "restrict" }),
  parentId: uuid("parent_id").references((): any => documents.id, { onDelete: "set null" }),
  slug: text("slug").notNull(),
  /** Leaf path of the doc within its section's local mount root, e.g.
   *  "auth.md" or "guides/auth.md". Server-owned canonical layout. */
  path: text("path").notNull(),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  tags: text("tags").array().notNull().default([]),
  /** Full-text search index — recomputed on content/title/tag changes */
  searchTsv: tsvector("search_tsv"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("documents_space_slug_idx").on(t.spaceId, t.slug),
  index("documents_space_idx").on(t.spaceId),
  index("documents_section_idx").on(t.sectionId),
  index("documents_parent_idx").on(t.parentId),
]);

export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  /** SeaweedFS key for pre-rendered HTML, null if not yet rendered */
  renderedKey: text("rendered_key"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("doc_version_unique").on(t.documentId, t.version),
  index("doc_versions_doc_idx").on(t.documentId),
]);

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").references(() => documentVersions.id),
  parentId: uuid("parent_id").references((): any => comments.id),
  authorId: uuid("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  /** Text snippet the comment is anchored to. Null = page-level comment. */
  anchorText: text("anchor_text"),
  /** Heading hierarchy at anchor point, e.g. "Installation > Prerequisites" */
  anchorSection: text("anchor_section"),
  /** Surrounding lines for context, with anchor text marked */
  anchorContext: text("anchor_context"),
  resolved: boolean("resolved").notNull().default(false),
  /** Agent/bot name if comment was posted via an API key with actorName or --as flag */
  actorName: text("actor_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("comments_doc_idx").on(t.documentId),
  index("comments_parent_idx").on(t.parentId),
]);

export const themes = pgTable("themes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  orgId: uuid("org_id"),
  /** User who created the theme — gates mutation and deletion. Nullable for
   *  pre-migration rows; null means "no owner", treated as immutable. */
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  /** Design tokens: colors, spacing, font choices */
  tokens: jsonb("tokens").notNull().default({}),
  /** SeaweedFS keys for logo assets */
  logoAssets: text("logo_assets").array().notNull().default([]),
  /** Google Font family names — font files stored in SeaweedFS */
  fonts: text("fonts").array().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  /** SeaweedFS file ID */
  storageKey: text("storage_key").notNull(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "set null" }),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("assets_doc_idx").on(t.documentId),
  index("assets_owner_idx").on(t.ownerId),
  index("assets_space_idx").on(t.spaceId),
]);

/** Personal access tokens for API/CLI auth */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** SHA-256 hash of the key — the raw key is only shown once at creation */
  keyHash: text("key_hash").notNull(),
  /** First 8 chars of the key for display (e.g. "sk-a1b2c3d4...") */
  prefix: text("prefix").notNull(),
  /** Optional agent/bot name — when set, actions show as this name instead of user's name */
  actorName: text("actor_name"),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("api_keys_hash_idx").on(t.keyHash),
  index("api_keys_user_idx").on(t.userId),
]);

/** Explicit share grants for spaces */
export const spaceMembers = pgTable("space_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["viewer", "editor", "admin"] }).notNull().default("viewer"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("space_member_unique").on(t.spaceId, t.userId),
]);

/** Per-user, per-document read tracking */
export const documentReads = pgTable("document_reads", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  readAt: timestamp("read_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("document_reads_pk").on(t.userId, t.documentId),
]);

/** Document watch subscriptions */
export const documentWatches = pgTable("document_watches", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("document_watches_pk").on(t.userId, t.documentId),
  index("watches_doc_idx").on(t.documentId),
]);

/** Space watch subscriptions */
export const spaceWatches = pgTable("space_watches", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("space_watches_pk").on(t.userId, t.spaceId),
  index("space_watches_space_idx").on(t.spaceId),
]);

/** Share links — single-claim invite tokens for spaces */
export const shareLinks = pgTable("share_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull(),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["viewer", "editor", "admin"] }).notNull().default("viewer"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  claimedBy: uuid("claimed_by").references(() => users.id),
  claimedAt: timestamp("claimed_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("share_links_token_idx").on(t.token),
  index("share_links_space_idx").on(t.spaceId),
]);

/** In-app notifications (read status derived from document_reads) */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'reply', 'mention', 'doc_updated', 'new_comment'
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
  commentId: uuid("comment_id").references(() => comments.id, { onDelete: "set null" }),
  spaceSlug: text("space_slug").notNull(),
  docSlug: text("doc_slug").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  actorName: text("actor_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("notifications_user_idx").on(t.userId),
]);
