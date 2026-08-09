ALTER TABLE "fdp_companies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_companies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_companies_workspace_isolation" ON "fdp_companies"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
