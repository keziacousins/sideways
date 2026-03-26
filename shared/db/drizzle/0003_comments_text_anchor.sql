-- Replace integer offset anchors with text snippet anchors
ALTER TABLE "comments" ADD COLUMN "anchor_text" text;
--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN IF EXISTS "anchor_start";
--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN IF EXISTS "anchor_end";
