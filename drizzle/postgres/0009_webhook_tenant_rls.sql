ALTER TABLE "fdp_integrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integrations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_integrations_workspace_isolation" ON "fdp_integrations"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_workspace_inbox_items_workspace_isolation" ON "fdp_workspace_inbox_items"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_activity_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_activity_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_activity_events_workspace_isolation" ON "fdp_activity_events"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
