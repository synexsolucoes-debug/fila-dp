CREATE INDEX IF NOT EXISTS "fdp_users_created_id_idx"
  ON "fdp_users" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_workspaces_created_id_idx"
  ON "fdp_workspaces" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_platform_audit_created_id_idx"
  ON "fdp_platform_audit_events" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_platform_audit_entity_created_idx"
  ON "fdp_platform_audit_events" USING btree ("entity_type", "entity_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_integration_credentials_expiry_idx"
  ON "fdp_integration_credentials" USING btree ("workspace_id", "status", "expires_at");
