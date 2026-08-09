-- Outbox transacional, webhooks de saída assinados e API pública versionada.
-- Migration aditiva: nenhuma tabela existente é alterada ou removida.
CREATE TABLE "fdp_domain_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"actor_user_id" text,
	"request_id" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"deliveries_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "fdp_domain_events_status_check" CHECK ("fdp_domain_events"."status" IN ('pending', 'published', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "fdp_webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"secret_key_version" integer DEFAULT 1 NOT NULL,
	"event_types_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_webhook_endpoints_status_check" CHECK ("fdp_webhook_endpoints"."status" IN ('active', 'paused', 'disabled')),
	CONSTRAINT "fdp_webhook_endpoints_url_check" CHECK ("fdp_webhook_endpoints"."url" LIKE 'https://%')
);
--> statement-breakpoint
CREATE TABLE "fdp_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" text DEFAULT '' NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"response_status" integer DEFAULT 0 NOT NULL,
	"response_snippet" text DEFAULT '' NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_webhook_deliveries_status_check" CHECK ("fdp_webhook_deliveries"."status" IN ('pending', 'delivering', 'delivered', 'failed', 'dead_letter', 'canceled')),
	CONSTRAINT "fdp_webhook_deliveries_attempt_check" CHECK ("fdp_webhook_deliveries"."attempt" >= 0 AND "fdp_webhook_deliveries"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 120 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_api_keys_status_check" CHECK ("fdp_api_keys"."status" IN ('active', 'revoked')),
	CONSTRAINT "fdp_api_keys_rate_check" CHECK ("fdp_api_keys"."rate_limit_per_minute" > 0 AND "fdp_api_keys"."rate_limit_per_minute" <= 6000)
);
--> statement-breakpoint
CREATE TABLE "fdp_api_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_api_rate_limits_count_check" CHECK ("fdp_api_rate_limits"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_api_idempotency_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"api_key_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer DEFAULT 0 NOT NULL,
	"response_body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_domain_events_workspace_id_uq" ON "fdp_domain_events" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_domain_events_pending_idx" ON "fdp_domain_events" USING btree ("workspace_id","status","occurred_at");--> statement-breakpoint
CREATE INDEX "fdp_domain_events_type_idx" ON "fdp_domain_events" USING btree ("workspace_id","event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_webhook_endpoints_workspace_id_uq" ON "fdp_webhook_endpoints" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_webhook_endpoints_workspace_url_uq" ON "fdp_webhook_endpoints" USING btree ("workspace_id","url");--> statement-breakpoint
CREATE INDEX "fdp_webhook_endpoints_status_idx" ON "fdp_webhook_endpoints" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_webhook_deliveries_endpoint_event_uq" ON "fdp_webhook_deliveries" USING btree ("workspace_id","endpoint_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_webhook_deliveries_workspace_id_uq" ON "fdp_webhook_deliveries" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_webhook_deliveries_queue_idx" ON "fdp_webhook_deliveries" USING btree ("workspace_id","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_api_keys_prefix_uq" ON "fdp_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_api_keys_token_hash_uq" ON "fdp_api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_api_keys_workspace_id_uq" ON "fdp_api_keys" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_api_keys_workspace_status_idx" ON "fdp_api_keys" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "fdp_api_rate_limits_window_idx" ON "fdp_api_rate_limits" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_api_idempotency_key_uq" ON "fdp_api_idempotency_records" USING btree ("workspace_id","api_key_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_api_idempotency_workspace_id_uq" ON "fdp_api_idempotency_records" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_api_idempotency_expires_idx" ON "fdp_api_idempotency_records" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ADD CONSTRAINT "fdp_domain_events_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_webhook_endpoints" ADD CONSTRAINT "fdp_webhook_endpoints_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_webhook_deliveries" ADD CONSTRAINT "fdp_webhook_deliveries_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_webhook_deliveries" ADD CONSTRAINT "fdp_webhook_deliveries_endpoint_id_fdp_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."fdp_webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_webhook_deliveries" ADD CONSTRAINT "fdp_webhook_deliveries_event_id_fdp_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."fdp_domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_webhook_deliveries" ADD CONSTRAINT "fdp_webhook_deliveries_workspace_endpoint_fk" FOREIGN KEY ("workspace_id","endpoint_id") REFERENCES "public"."fdp_webhook_endpoints"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_webhook_deliveries" ADD CONSTRAINT "fdp_webhook_deliveries_workspace_event_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."fdp_domain_events"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_api_keys" ADD CONSTRAINT "fdp_api_keys_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_api_idempotency_records" ADD CONSTRAINT "fdp_api_idempotency_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_api_idempotency_records" ADD CONSTRAINT "fdp_api_idempotency_workspace_key_fk" FOREIGN KEY ("workspace_id","api_key_id") REFERENCES "public"."fdp_api_keys"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_domain_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_webhook_endpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_webhook_endpoints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_api_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_api_idempotency_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_api_idempotency_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_domain_events_workspace_isolation" ON "fdp_domain_events"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_webhook_endpoints_workspace_isolation" ON "fdp_webhook_endpoints"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_webhook_deliveries_workspace_isolation" ON "fdp_webhook_deliveries"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_api_keys_workspace_isolation" ON "fdp_api_keys"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_api_idempotency_records_workspace_isolation" ON "fdp_api_idempotency_records"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
-- Um evento publicado é histórico: conteúdo e origem não mudam depois disso.
CREATE OR REPLACE FUNCTION "fdp_domain_events_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'domain events are append-only';
  END IF;
  IF OLD.status = 'published' AND (
    NEW.payload_json IS DISTINCT FROM OLD.payload_json OR
    NEW.event_type IS DISTINCT FROM OLD.event_type OR
    NEW.entity_id IS DISTINCT FROM OLD.entity_id OR
    NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
  ) THEN
    RAISE EXCEPTION 'published domain event is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_domain_events_guard"
BEFORE UPDATE OR DELETE ON "fdp_domain_events"
FOR EACH ROW EXECUTE FUNCTION "fdp_domain_events_guard"();
