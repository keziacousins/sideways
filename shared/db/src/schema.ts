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

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  visibility: text("visibility", {
    enum: ["private", "shared", "org", "public"],
  }).notNull().default("private"),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  parentId: uuid("parent_id").references((): any => documents.id),
  position: integer("position").notNull().default(0),
  tags: text("tags").array().notNull().default([]),
  themeId: uuid("theme_id").references(() => themes.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("documents_slug_idx").on(t.slug),
  index("documents_owner_idx").on(t.ownerId),
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
  /** For inline comments: character offset range */
  anchorStart: integer("anchor_start"),
  anchorEnd: integer("anchor_end"),
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
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("assets_doc_idx").on(t.documentId),
  index("assets_owner_idx").on(t.ownerId),
]);

/** Explicit share grants for documents */
export const documentShares = pgTable("document_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("doc_share_unique").on(t.documentId, t.userId),
]);
