-- Sankhya Browser Connector: extensão aditiva do motor de integrações existente.
-- O aplicativo continua na Vercel; sessões Playwright são consumidas por um worker dedicado.
ALTER TABLE "fdp_integrations" ADD COLUMN IF NOT EXISTS "last_connection_at" timestamp with time zone;
ALTER TABLE "fdp_integrations" ADD COLUMN IF NOT EXISTS "last_successful_sync_at" timestamp with time zone;
ALTER TABLE "fdp_integrations" ADD COLUMN IF NOT EXISTS "next_sync_at" timestamp with time zone;
ALTER TABLE "fdp_integrations" ADD COLUMN IF NOT EXISTS "schedule_enabled" integer DEFAULT 0 NOT NULL;
ALTER TABLE "fdp_integrations" ADD COLUMN IF NOT EXISTS "connector_version" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_integration_credentials" ADD COLUMN IF NOT EXISTS "public_hint" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" ADD COLUMN IF NOT EXISTS "updated_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "fdp_integration_sync_runs" ADD COLUMN IF NOT EXISTS "unchanged_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "fdp_integration_sync_runs" ADD COLUMN IF NOT EXISTS "duration_ms" integer DEFAULT 0 NOT NULL;
ALTER TABLE "fdp_integration_sync_runs" ADD COLUMN IF NOT EXISTS "summary" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" DROP CONSTRAINT IF EXISTS "fdp_integration_sync_runs_trigger_check";
ALTER TABLE "fdp_integration_sync_runs" ADD CONSTRAINT "fdp_integration_sync_runs_trigger_check"
  CHECK ("trigger_type" IN ('manual', 'scheduled', 'webhook', 'retry', 'health_check'));
ALTER TABLE "fdp_integration_sync_runs" DROP CONSTRAINT IF EXISTS "fdp_integration_sync_runs_status_check";
ALTER TABLE "fdp_integration_sync_runs" ADD CONSTRAINT "fdp_integration_sync_runs_status_check"
  CHECK ("status" IN ('queued', 'running', 'authenticating', 'navigating', 'processing', 'extracting', 'importing', 'succeeded', 'partial', 'failed', 'requires_user_action', 'canceled'));
ALTER TABLE "fdp_integration_sync_runs" DROP CONSTRAINT IF EXISTS "fdp_integration_sync_runs_counts_check";
ALTER TABLE "fdp_integration_sync_runs" ADD CONSTRAINT "fdp_integration_sync_runs_counts_check"
  CHECK ("attempt" >= 0 AND "received_count" >= 0 AND "processed_count" >= 0 AND "skipped_count" >= 0
    AND "conflict_count" >= 0 AND "failed_count" >= 0 AND "updated_count" >= 0 AND "unchanged_count" >= 0 AND "duration_ms" >= 0);
--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" DROP CONSTRAINT IF EXISTS "fdp_integration_jobs_type_check";
ALTER TABLE "fdp_integration_jobs" ADD CONSTRAINT "fdp_integration_jobs_type_check"
  CHECK ("job_type" IN ('sync', 'retry', 'reconcile', 'health_check'));
--> statement-breakpoint
ALTER TABLE "fdp_employees" DROP CONSTRAINT IF EXISTS "fdp_employees_source_check";
ALTER TABLE "fdp_employees" ADD CONSTRAINT "fdp_employees_source_check" CHECK ("source_system" IN ('manual', 'solides', 'sankhya'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_sankhya_active_run_uq" ON "fdp_integration_sync_runs" ("workspace_id", "integration_id")
  WHERE "mapping_id" IS NULL AND "status" IN ('queued', 'running', 'authenticating', 'navigating', 'processing', 'extracting', 'importing');
CREATE INDEX IF NOT EXISTS "fdp_integrations_sankhya_schedule_idx" ON "fdp_integrations" ("channel", "schedule_enabled", "next_sync_at")
  WHERE "channel" = 'sankhya_browser';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fdp_integration_run_logs" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "run_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "level" text DEFAULT 'info' NOT NULL,
  "phase" text DEFAULT 'queued' NOT NULL,
  "code" text DEFAULT '' NOT NULL,
  "message" text NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_integration_run_logs_level_check" CHECK ("level" IN ('info', 'warn', 'error')),
  CONSTRAINT "fdp_integration_run_logs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  CONSTRAINT "fdp_integration_run_logs_integration_fk" FOREIGN KEY ("integration_id") REFERENCES "fdp_integrations"("id") ON DELETE cascade,
  CONSTRAINT "fdp_integration_run_logs_run_fk" FOREIGN KEY ("run_id") REFERENCES "fdp_integration_sync_runs"("id") ON DELETE cascade,
  CONSTRAINT "fdp_integration_run_logs_workspace_run_fk" FOREIGN KEY ("workspace_id", "integration_id", "run_id") REFERENCES "fdp_integration_sync_runs"("workspace_id", "integration_id", "id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_integration_run_logs_run_sequence_uq" ON "fdp_integration_run_logs" ("run_id", "sequence");
CREATE INDEX IF NOT EXISTS "fdp_integration_run_logs_workspace_run_idx" ON "fdp_integration_run_logs" ("workspace_id", "run_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fdp_integration_diagnostics" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "run_id" text NOT NULL,
  "kind" text DEFAULT 'screenshot' NOT NULL,
  "object_key" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_integration_diagnostics_kind_check" CHECK ("kind" IN ('screenshot')),
  CONSTRAINT "fdp_integration_diagnostics_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  CONSTRAINT "fdp_integration_diagnostics_workspace_run_fk" FOREIGN KEY ("workspace_id", "integration_id", "run_id") REFERENCES "fdp_integration_sync_runs"("workspace_id", "integration_id", "id") ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "fdp_integration_diagnostics_workspace_run_idx" ON "fdp_integration_diagnostics" ("workspace_id", "run_id", "expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fdp_employee_external_refs" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "employee_id" text,
  "source" text DEFAULT 'sankhya' NOT NULL,
  "external_id" text NOT NULL,
  "registration_number" text DEFAULT '' NOT NULL,
  "normalized_hash" text NOT NULL,
  "normalized_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_employee_external_refs_source_check" CHECK ("source" IN ('sankhya')),
  CONSTRAINT "fdp_employee_external_refs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  CONSTRAINT "fdp_employee_external_refs_workspace_integration_fk" FOREIGN KEY ("workspace_id", "integration_id") REFERENCES "fdp_integrations"("workspace_id", "id") ON DELETE cascade,
  CONSTRAINT "fdp_employee_external_refs_workspace_employee_fk" FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "fdp_employees"("workspace_id", "id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_employee_external_refs_workspace_id_uq" ON "fdp_employee_external_refs" ("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_employee_external_refs_source_external_uq" ON "fdp_employee_external_refs" ("workspace_id", "integration_id", "source", "external_id");
CREATE INDEX IF NOT EXISTS "fdp_employee_external_refs_employee_idx" ON "fdp_employee_external_refs" ("workspace_id", "employee_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fdp_employee_sync_changes" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "integration_id" text NOT NULL,
  "run_id" text NOT NULL,
  "external_ref_id" text NOT NULL,
  "employee_id" text,
  "classification" text NOT NULL,
  "changed_fields_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "before_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "after_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fdp_employee_sync_changes_classification_check" CHECK ("classification" IN ('new', 'changed', 'unchanged', 'invalid')),
  CONSTRAINT "fdp_employee_sync_changes_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  CONSTRAINT "fdp_employee_sync_changes_workspace_run_fk" FOREIGN KEY ("workspace_id", "integration_id", "run_id") REFERENCES "fdp_integration_sync_runs"("workspace_id", "integration_id", "id") ON DELETE cascade,
  CONSTRAINT "fdp_employee_sync_changes_workspace_ref_fk" FOREIGN KEY ("workspace_id", "external_ref_id") REFERENCES "fdp_employee_external_refs"("workspace_id", "id") ON DELETE cascade,
  CONSTRAINT "fdp_employee_sync_changes_workspace_employee_fk" FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "fdp_employees"("workspace_id", "id")
);
CREATE INDEX IF NOT EXISTS "fdp_employee_sync_changes_workspace_run_idx" ON "fdp_employee_sync_changes" ("workspace_id", "run_id", "created_at");
--> statement-breakpoint
ALTER TABLE "fdp_integration_run_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fdp_integration_run_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fdp_integration_run_logs_workspace_isolation" ON "fdp_integration_run_logs"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
ALTER TABLE "fdp_integration_diagnostics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fdp_integration_diagnostics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fdp_integration_diagnostics_workspace_isolation" ON "fdp_integration_diagnostics"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
ALTER TABLE "fdp_employee_external_refs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fdp_employee_external_refs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fdp_employee_external_refs_workspace_isolation" ON "fdp_employee_external_refs"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
ALTER TABLE "fdp_employee_sync_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fdp_employee_sync_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fdp_employee_sync_changes_workspace_isolation" ON "fdp_employee_sync_changes"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
-- O módulo não entra em nenhum plano automaticamente. A plataforma o libera por workspace.
INSERT INTO "fdp_modules" ("key", "name", "description", "category", "route", "required_capability", "depends_on", "position")
VALUES ('sankhya_browser', 'Sankhya Browser Connector', 'Consulta o DP Explorer por automação de navegador isolada.', 'gestao', 'integrations', 'integrations.view', 'integrations', 1010)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "fdp_integrations" ("id", "workspace_id", "channel", "display_name", "status", "connector_version")
SELECT workspace."id" || ':integration:sankhya_browser', workspace."id", 'sankhya_browser', 'Sankhya Browser Connector', 'needs_credentials', '1'
FROM "fdp_workspaces" workspace
ON CONFLICT ("workspace_id", "channel") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_integration_credentials_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'integration credentials are append-only';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.integration_id IS DISTINCT FROM OLD.integration_id OR
     NEW.credential_type IS DISTINCT FROM OLD.credential_type OR NEW.encrypted_value IS DISTINCT FROM OLD.encrypted_value OR
     NEW.initialization_vector IS DISTINCT FROM OLD.initialization_vector OR NEW.auth_tag IS DISTINCT FROM OLD.auth_tag OR
     NEW.key_version IS DISTINCT FROM OLD.key_version OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR
     NEW.public_hint IS DISTINCT FROM OLD.public_hint OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sealed integration credential is immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'invalid integration credential status transition';
  END IF;
  RETURN NEW;
END;
$$;
