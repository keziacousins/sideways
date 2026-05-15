-- Phase 3: path-as-URL.
-- Retire `slug` as the document identifier. Identity is now (space, section,
-- path); URL is built by `docUrl()` from `@sideways/types`.
-- Notifications stop denormalising space/doc slug — URLs derive from
-- documentId at read time so renames/moves don't leave stale links.

DROP INDEX IF EXISTS "documents_space_slug_idx";
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "slug";
--> statement-breakpoint
CREATE UNIQUE INDEX "documents_space_section_path_idx"
  ON "documents" ("space_id", "section_id", "path");
--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "space_slug";
--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "doc_slug";
