-- Add spaces and sections, restructure documents

CREATE TABLE "spaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "visibility" text DEFAULT 'private' NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "users"("id"),
  "theme_id" uuid REFERENCES "themes"("id"),
  "personal" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_slug_idx" ON "spaces" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX "spaces_owner_idx" ON "spaces" USING btree ("owner_id");

--> statement-breakpoint
CREATE TABLE "sections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "parent_id" uuid REFERENCES "sections"("id"),
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sections_space_slug_idx" ON "sections" USING btree ("space_id", "slug");
--> statement-breakpoint
CREATE INDEX "sections_parent_idx" ON "sections" USING btree ("parent_id");

--> statement-breakpoint
-- Create a default space for existing documents
INSERT INTO "spaces" ("id", "slug", "name", "visibility", "owner_id", "personal")
SELECT gen_random_uuid(), 'default', 'Default', 'public',
  (SELECT "id" FROM "users" LIMIT 1),
  false
WHERE EXISTS (SELECT 1 FROM "documents");

--> statement-breakpoint
-- Add space_id and section_id to documents
ALTER TABLE "documents" ADD COLUMN "space_id" uuid REFERENCES "spaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "section_id" uuid REFERENCES "sections"("id") ON DELETE SET NULL;

--> statement-breakpoint
-- Assign existing documents to the default space
UPDATE "documents" SET "space_id" = (SELECT "id" FROM "spaces" WHERE "slug" = 'default' LIMIT 1)
WHERE "space_id" IS NULL;

--> statement-breakpoint
-- Now make space_id NOT NULL
ALTER TABLE "documents" ALTER COLUMN "space_id" SET NOT NULL;

--> statement-breakpoint
-- Remove old columns from documents (visibility/owner moved to space)
ALTER TABLE "documents" DROP COLUMN IF EXISTS "visibility";
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "owner_id";
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "parent_id";
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "theme_id";

--> statement-breakpoint
-- Replace unique slug index with space-scoped slug
DROP INDEX IF EXISTS "documents_slug_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "documents_space_slug_idx" ON "documents" USING btree ("space_id", "slug");
--> statement-breakpoint
CREATE INDEX "documents_space_idx" ON "documents" USING btree ("space_id");
--> statement-breakpoint
CREATE INDEX "documents_section_idx" ON "documents" USING btree ("section_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "documents_owner_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "documents_parent_idx";

--> statement-breakpoint
-- Add space_id to assets
ALTER TABLE "assets" ADD COLUMN "space_id" uuid REFERENCES "spaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "assets_space_idx" ON "assets" USING btree ("space_id");

--> statement-breakpoint
-- Replace document_shares with space_members
DROP TABLE IF EXISTS "document_shares";
--> statement-breakpoint
CREATE TABLE "space_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text DEFAULT 'viewer' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "space_member_unique" ON "space_members" USING btree ("space_id", "user_id");
