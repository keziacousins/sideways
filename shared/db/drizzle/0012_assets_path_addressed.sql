-- Hosted assets (#66): path-addressed files beside the documents.
--
-- The old `assets` table was never read or written by any route, so this is
-- a drop-and-recreate rather than an in-place reshape.
--
-- Apply this by hand BEFORE the first deploy that carries the new schema.
-- `drizzle-kit push` sees a table that both loses and gains columns and asks
-- whether each new column is a rename; `--force` does not answer that prompt,
-- and with no TTY over SSH the push aborts. Once this has run, the push finds
-- nothing left to do.

DROP TABLE IF EXISTS "assets";
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "assets_space_section_path_idx" ON "assets" USING btree ("space_id","section_id","path");
--> statement-breakpoint
CREATE INDEX "assets_storage_key_idx" ON "assets" USING btree ("storage_key");
