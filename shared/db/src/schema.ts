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
} from "drizzle-orm/pg-core";

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
  sectionId: uuid("section_id").references(() => sections.id, { onDelete: "set null" }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  tags: text("tags").array().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("documents_space_slug_idx").on(t.spaceId, t.slug),
  index("documents_space_idx").on(t.spaceId),
  index("documents_section_idx").on(t.sectionId),
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
  resolved: boolean("resolved").notNull().default(false),
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
