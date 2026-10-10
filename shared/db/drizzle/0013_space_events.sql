-- Per-space activity log (#92).
--
-- Apply this by hand BEFORE the first deploy that carries the new schema, so
-- the log starts with the history the database already holds. Creating the
-- table is safe to repeat, and `drizzle-kit push` finds nothing left to do
-- afterwards. The backfill only runs into an empty table: once the deployed
-- server has written its first event, running this adds nothing.
--
-- Backfilled from document versions and comments, which is all the history
-- there is. Deletes, renames and moves made before this point left no record
-- and are absent, a document that changed space is logged under the space it
-- is in now, and versions carry no agent name, so an agent's past edits are
-- logged under the owner of the key it used.

CREATE TABLE IF NOT EXISTS "space_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"document_id" uuid,
	"comment_id" uuid,
	"title" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "space_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "space_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_events_space_created_idx" ON "space_events" USING btree ("space_id","created_at","id");
--> statement-breakpoint
INSERT INTO "space_events" ("space_id", "type", "actor_id", "actor_name", "document_id", "comment_id", "title", "created_at")
SELECT history.*
FROM (
	SELECT
		d."space_id",
		CASE WHEN v."version" = 1 THEN 'doc_created' ELSE 'doc_edited' END,
		v."created_by",
		u."name",
		d."id",
		NULL::uuid,
		v."title",
		v."created_at"
	FROM "document_versions" v
	JOIN "documents" d ON d."id" = v."document_id"
	JOIN "users" u ON u."id" = v."created_by"
	UNION ALL
	SELECT
		d."space_id",
		'comment_created',
		c."author_id",
		CASE WHEN c."actor_name" IS NULL THEN u."name" ELSE c."actor_name" || ' via ' || u."name" END,
		d."id",
		c."id",
		d."title",
		c."created_at"
	FROM "comments" c
	JOIN "documents" d ON d."id" = c."document_id"
	JOIN "users" u ON u."id" = c."author_id"
) history
WHERE NOT EXISTS (SELECT 1 FROM "space_events");
