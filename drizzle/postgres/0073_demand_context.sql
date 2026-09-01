-- Contexto completo da demanda: colaborador e solicitante vinculados ao tenant.
SELECT pg_advisory_xact_lock(hashtext('0073_demand_context'));
--> statement-breakpoint

ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "employee_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "requester_user_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_workspace_employee_fk";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_workspace_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_workspace_requester_user_fk";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_workspace_requester_user_fk"
  FOREIGN KEY ("workspace_id", "requester_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_cards_workspace_employee_idx"
  ON "fdp_cards" ("workspace_id", "employee_id", "created_at")
  WHERE "employee_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_cards_workspace_requester_user_idx"
  ON "fdp_cards" ("workspace_id", "requester_user_id", "created_at")
  WHERE "requester_user_id" IS NOT NULL;
