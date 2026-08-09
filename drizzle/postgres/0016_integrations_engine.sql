CREATE TABLE "fdp_integration_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"integration_id" text NOT NULL,
	"credential_type" text DEFAULT 'provider_auth' NOT NULL,
	"encrypted_value" text NOT NULL,
	"initialization_vector" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_integration_credentials_type_check" CHECK ("fdp_integration_credentials"."credential_type" IN ('provider_auth', 'webhook_signing')),
	CONSTRAINT "fdp_integration_credentials_status_check" CHECK ("fdp_integration_credentials"."status" IN ('active', 'revoked')),
	CONSTRAINT "fdp_integration_credentials_key_version_check" CHECK ("fdp_integration_credentials"."key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_integration_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"integration_id" text NOT NULL,
	"run_id" text NOT NULL,
	"job_type" text DEFAULT 'sync' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" text DEFAULT '' NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text DEFAULT '' NOT NULL,
	"last_error_message" text DEFAULT '' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_integration_jobs_type_check" CHECK ("fdp_integration_jobs"."job_type" IN ('sync', 'retry', 'reconcile')),
	CONSTRAINT "fdp_integration_jobs_status_check" CHECK ("fdp_integration_jobs"."status" IN ('queued', 'leased', 'succeeded', 'failed', 'dead_letter', 'canceled')),
	CONSTRAINT "fdp_integration_jobs_attempt_check" CHECK ("fdp_integration_jobs"."attempt" >= 0 AND "fdp_integration_jobs"."max_attempts" BETWEEN 1 AND 12 AND "fdp_integration_jobs"."attempt" <= "fdp_integration_jobs"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "fdp_integration_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"integration_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"mapping_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checksum" text NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_integration_mappings_resource_check" CHECK ("fdp_integration_mappings"."resource_type" IN ('inbox', 'employees', 'hr_metrics', 'files')),
	CONSTRAINT "fdp_integration_mappings_direction_check" CHECK ("fdp_integration_mappings"."direction" IN ('inbound', 'outbound', 'bidirectional')),
	CONSTRAINT "fdp_integration_mappings_status_check" CHECK ("fdp_integration_mappings"."status" IN ('draft', 'active', 'archived')),
	CONSTRAINT "fdp_integration_mappings_version_check" CHECK ("fdp_integration_mappings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_integration_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"integration_id" text NOT NULL,
	"run_id" text NOT NULL,
	"item_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"internal_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"differences_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"resolution_note" text DEFAULT '' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_integration_reconciliations_entity_check" CHECK ("fdp_integration_reconciliations"."entity_type" IN ('inbox', 'employee', 'hr_metric', 'file')),
	CONSTRAINT "fdp_integration_reconciliations_status_check" CHECK ("fdp_integration_reconciliations"."status" IN ('matched', 'unmatched', 'conflict', 'ignored', 'resolved')),
	CONSTRAINT "fdp_integration_reconciliations_resolution_check" CHECK ("fdp_integration_reconciliations"."resolution" IN ('', 'link', 'accept_external', 'keep_internal', 'ignore'))
);
--> statement-breakpoint
CREATE TABLE "fdp_integration_sync_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"integration_id" text NOT NULL,
	"run_id" text NOT NULL,
	"mapping_id" text,
	"item_key" text NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload_hash" text NOT NULL,
	"target_type" text DEFAULT '' NOT NULL,
	"target_id" text DEFAULT '' NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"error_message" text DEFAULT '' NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_integration_sync_items_direction_check" CHECK ("fdp_integration_sync_items"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "fdp_integration_sync_items_status_check" CHECK ("fdp_integration_sync_items"."status" IN ('pending', 'processed', 'skipped', 'conflict', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "fdp_integration_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"integration_id" text NOT NULL,
	"mapping_id" text,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"cursor" text DEFAULT '' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"received_count" integer DEFAULT 0 NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"error_message" text DEFAULT '' NOT NULL,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_integration_sync_runs_trigger_check" CHECK ("fdp_integration_sync_runs"."trigger_type" IN ('manual', 'scheduled', 'webhook', 'retry')),
	CONSTRAINT "fdp_integration_sync_runs_status_check" CHECK ("fdp_integration_sync_runs"."status" IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'canceled')),
	CONSTRAINT "fdp_integration_sync_runs_counts_check" CHECK ("fdp_integration_sync_runs"."attempt" >= 0 AND "fdp_integration_sync_runs"."received_count" >= 0 AND "fdp_integration_sync_runs"."processed_count" >= 0 AND "fdp_integration_sync_runs"."skipped_count" >= 0 AND "fdp_integration_sync_runs"."conflict_count" >= 0 AND "fdp_integration_sync_runs"."failed_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "fdp_integration_credentials" ADD CONSTRAINT "fdp_integration_credentials_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_credentials" ADD CONSTRAINT "fdp_integration_credentials_integration_id_fdp_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."fdp_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_credentials" ADD CONSTRAINT "fdp_integration_credentials_workspace_integration_fk" FOREIGN KEY ("workspace_id","integration_id") REFERENCES "public"."fdp_integrations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_credentials" ADD CONSTRAINT "fdp_integration_credentials_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" ADD CONSTRAINT "fdp_integration_jobs_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" ADD CONSTRAINT "fdp_integration_jobs_integration_id_fdp_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."fdp_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" ADD CONSTRAINT "fdp_integration_jobs_run_id_fdp_integration_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fdp_integration_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" ADD CONSTRAINT "fdp_integration_jobs_workspace_run_fk" FOREIGN KEY ("workspace_id","integration_id","run_id") REFERENCES "public"."fdp_integration_sync_runs"("workspace_id","integration_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_mappings" ADD CONSTRAINT "fdp_integration_mappings_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_mappings" ADD CONSTRAINT "fdp_integration_mappings_integration_id_fdp_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."fdp_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_mappings" ADD CONSTRAINT "fdp_integration_mappings_workspace_integration_fk" FOREIGN KEY ("workspace_id","integration_id") REFERENCES "public"."fdp_integrations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_mappings" ADD CONSTRAINT "fdp_integration_mappings_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_mappings" ADD CONSTRAINT "fdp_integration_mappings_workspace_publisher_fk" FOREIGN KEY ("workspace_id","published_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ADD CONSTRAINT "fdp_integration_reconciliations_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ADD CONSTRAINT "fdp_integration_reconciliations_integration_id_fdp_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."fdp_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ADD CONSTRAINT "fdp_integration_reconciliations_run_id_fdp_integration_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fdp_integration_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ADD CONSTRAINT "fdp_integration_reconciliations_item_id_fdp_integration_sync_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."fdp_integration_sync_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ADD CONSTRAINT "fdp_integration_reconciliations_workspace_run_fk" FOREIGN KEY ("workspace_id","integration_id","run_id") REFERENCES "public"."fdp_integration_sync_runs"("workspace_id","integration_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ADD CONSTRAINT "fdp_integration_reconciliations_workspace_item_fk" FOREIGN KEY ("workspace_id","item_id") REFERENCES "public"."fdp_integration_sync_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ADD CONSTRAINT "fdp_integration_reconciliations_workspace_resolver_fk" FOREIGN KEY ("workspace_id","resolved_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" ADD CONSTRAINT "fdp_integration_sync_items_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" ADD CONSTRAINT "fdp_integration_sync_items_integration_id_fdp_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."fdp_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" ADD CONSTRAINT "fdp_integration_sync_items_run_id_fdp_integration_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fdp_integration_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" ADD CONSTRAINT "fdp_integration_sync_items_workspace_run_fk" FOREIGN KEY ("workspace_id","integration_id","run_id") REFERENCES "public"."fdp_integration_sync_runs"("workspace_id","integration_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" ADD CONSTRAINT "fdp_integration_sync_items_workspace_mapping_fk" FOREIGN KEY ("workspace_id","integration_id","mapping_id") REFERENCES "public"."fdp_integration_mappings"("workspace_id","integration_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" ADD CONSTRAINT "fdp_integration_sync_runs_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" ADD CONSTRAINT "fdp_integration_sync_runs_integration_id_fdp_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."fdp_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" ADD CONSTRAINT "fdp_integration_sync_runs_workspace_integration_fk" FOREIGN KEY ("workspace_id","integration_id") REFERENCES "public"."fdp_integrations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" ADD CONSTRAINT "fdp_integration_sync_runs_workspace_mapping_fk" FOREIGN KEY ("workspace_id","integration_id","mapping_id") REFERENCES "public"."fdp_integration_mappings"("workspace_id","integration_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" ADD CONSTRAINT "fdp_integration_sync_runs_workspace_requester_fk" FOREIGN KEY ("workspace_id","requested_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_credentials_workspace_id_uq" ON "fdp_integration_credentials" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_credentials_active_uq" ON "fdp_integration_credentials" USING btree ("workspace_id","integration_id","credential_type") WHERE "fdp_integration_credentials"."status" = 'active';--> statement-breakpoint
CREATE INDEX "fdp_integration_credentials_workspace_integration_idx" ON "fdp_integration_credentials" USING btree ("workspace_id","integration_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_jobs_workspace_id_uq" ON "fdp_integration_jobs" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_jobs_idempotency_uq" ON "fdp_integration_jobs" USING btree ("workspace_id","integration_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "fdp_integration_jobs_claim_idx" ON "fdp_integration_jobs" USING btree ("workspace_id","status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_mappings_integration_resource_version_uq" ON "fdp_integration_mappings" USING btree ("integration_id","resource_type","direction","version");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_mappings_workspace_id_uq" ON "fdp_integration_mappings" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_mappings_workspace_integration_id_uq" ON "fdp_integration_mappings" USING btree ("workspace_id","integration_id","id");--> statement-breakpoint
CREATE INDEX "fdp_integration_mappings_workspace_status_idx" ON "fdp_integration_mappings" USING btree ("workspace_id","integration_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_reconciliations_workspace_id_uq" ON "fdp_integration_reconciliations" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_reconciliations_item_uq" ON "fdp_integration_reconciliations" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "fdp_integration_reconciliations_workspace_status_idx" ON "fdp_integration_reconciliations" USING btree ("workspace_id","integration_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_sync_items_workspace_id_uq" ON "fdp_integration_sync_items" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_sync_items_run_key_uq" ON "fdp_integration_sync_items" USING btree ("run_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_sync_items_payload_uq" ON "fdp_integration_sync_items" USING btree ("workspace_id","integration_id","mapping_id","external_id","payload_hash");--> statement-breakpoint
CREATE INDEX "fdp_integration_sync_items_workspace_run_status_idx" ON "fdp_integration_sync_items" USING btree ("workspace_id","run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_sync_runs_workspace_id_uq" ON "fdp_integration_sync_runs" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_sync_runs_idempotency_uq" ON "fdp_integration_sync_runs" USING btree ("workspace_id","integration_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_sync_runs_workspace_integration_id_uq" ON "fdp_integration_sync_runs" USING btree ("workspace_id","integration_id","id");--> statement-breakpoint
CREATE INDEX "fdp_integration_sync_runs_workspace_status_idx" ON "fdp_integration_sync_runs" USING btree ("workspace_id","status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_integration_mappings_active_uq" ON "fdp_integration_mappings" ("workspace_id", "integration_id", "resource_type", "direction") WHERE "status" = 'active';
--> statement-breakpoint
ALTER TABLE "fdp_integration_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_mappings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_mappings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_sync_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_integration_reconciliations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_integration_credentials_workspace_isolation" ON "fdp_integration_credentials"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_integration_mappings_workspace_isolation" ON "fdp_integration_mappings"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_integration_sync_runs_workspace_isolation" ON "fdp_integration_sync_runs"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_integration_sync_items_workspace_isolation" ON "fdp_integration_sync_items"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_integration_jobs_workspace_isolation" ON "fdp_integration_jobs"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_integration_reconciliations_workspace_isolation" ON "fdp_integration_reconciliations"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_integration_credentials_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'integration credentials are append-only';
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.integration_id IS DISTINCT FROM OLD.integration_id OR
     NEW.credential_type IS DISTINCT FROM OLD.credential_type OR
     NEW.encrypted_value IS DISTINCT FROM OLD.encrypted_value OR
     NEW.initialization_vector IS DISTINCT FROM OLD.initialization_vector OR
     NEW.auth_tag IS DISTINCT FROM OLD.auth_tag OR
     NEW.key_version IS DISTINCT FROM OLD.key_version OR
     NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR
     NEW.created_by IS DISTINCT FROM OLD.created_by OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sealed integration credential is immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'invalid integration credential status transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_integration_credentials_guard"
BEFORE UPDATE OR DELETE ON "fdp_integration_credentials"
FOR EACH ROW EXECUTE FUNCTION "fdp_integration_credentials_guard"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_integration_mappings_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'published integration mapping is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
    NEW.integration_id IS DISTINCT FROM OLD.integration_id OR
    NEW.resource_type IS DISTINCT FROM OLD.resource_type OR
    NEW.direction IS DISTINCT FROM OLD.direction OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.mapping_json IS DISTINCT FROM OLD.mapping_json OR
    NEW.checksum IS DISTINCT FROM OLD.checksum OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'published integration mapping is immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'active') OR
    (OLD.status = 'active' AND NEW.status = 'archived')
  ) THEN
    RAISE EXCEPTION 'invalid integration mapping status transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_integration_mappings_guard"
BEFORE UPDATE OR DELETE ON "fdp_integration_mappings"
FOR EACH ROW EXECUTE FUNCTION "fdp_integration_mappings_guard"();
