ALTER TABLE "fdp_hr_metrics" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_hr_metrics" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_hr_metrics_workspace_isolation" ON "fdp_hr_metrics"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_labels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_labels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_labels_workspace_isolation" ON "fdp_labels"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_custom_fields" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_custom_fields" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_custom_fields_workspace_isolation" ON "fdp_custom_fields"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_process_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_process_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_process_templates_workspace_isolation" ON "fdp_process_templates"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_business_holidays" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_business_holidays" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_business_holidays_workspace_isolation" ON "fdp_business_holidays"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_sla_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_sla_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_sla_policies_workspace_isolation" ON "fdp_sla_policies"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_workspace_settings_workspace_isolation" ON "fdp_workspace_settings"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_automation_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_automation_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_automation_rules_workspace_isolation" ON "fdp_automation_rules"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
