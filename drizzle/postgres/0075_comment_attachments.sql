-- Comentário com anexo rastreável (§44).
SELECT pg_advisory_xact_lock(hashtext('0075_comment_attachments'));
--> statement-breakpoint

ALTER TABLE "fdp_card_attachments" ADD COLUMN IF NOT EXISTS "comment_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" DROP CONSTRAINT IF EXISTS "fdp_card_attachments_comment_fk";
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD CONSTRAINT "fdp_card_attachments_comment_fk"
  FOREIGN KEY ("workspace_id", "comment_id")
  REFERENCES "public"."fdp_card_comments"("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_attachments_comment_idx"
  ON "fdp_card_attachments" ("workspace_id", "comment_id")
  WHERE "comment_id" IS NOT NULL;
