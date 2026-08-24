-- Exclusão lógica de fechamento PJ.
-- O pagamento sai da operação, totais, Caju e relatórios sem apagar a trilha financeira.
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN "excluded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN "excluded_by" text;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD COLUMN "exclusion_reason" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD CONSTRAINT "fdp_contractor_closings_exclusion_reason_check"
  CHECK ("excluded_at" IS NULL OR length("exclusion_reason") >= 5);
--> statement-breakpoint
ALTER TABLE "fdp_contractor_closings"
  ADD CONSTRAINT "fdp_contractor_closings_workspace_excluded_by_fk"
  FOREIGN KEY ("workspace_id", "excluded_by")
  REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "fdp_contractor_closings_workspace_cycle_active_idx"
  ON "fdp_contractor_closings" USING btree ("workspace_id", "company_id", "payroll_cycle_id", "excluded_at");
