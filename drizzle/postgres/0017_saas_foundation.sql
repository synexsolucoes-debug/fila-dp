CREATE TABLE "fdp_billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'processed' NOT NULL,
	"object_type" text DEFAULT '' NOT NULL,
	"object_id" text DEFAULT '' NOT NULL,
	"summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_billing_events_status_check" CHECK ("fdp_billing_events"."status" IN ('processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "fdp_billing_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"subscription_id" text NOT NULL,
	"external_invoice_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"currency" text DEFAULT 'brl' NOT NULL,
	"amount_due_cents" integer DEFAULT 0 NOT NULL,
	"amount_paid_cents" integer DEFAULT 0 NOT NULL,
	"hosted_invoice_url" text DEFAULT '' NOT NULL,
	"period_starts_at" timestamp with time zone,
	"period_ends_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_billing_invoices_status_check" CHECK ("fdp_billing_invoices"."status" IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
	CONSTRAINT "fdp_billing_invoices_amount_check" CHECK ("fdp_billing_invoices"."amount_due_cents" >= 0 AND "fdp_billing_invoices"."amount_paid_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_platform_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_email" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"before_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fdp_saas_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"currency" text DEFAULT 'brl' NOT NULL,
	"monthly_price_cents" integer DEFAULT 0 NOT NULL,
	"annual_price_cents" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 14 NOT NULL,
	"included_seats" integer DEFAULT 3 NOT NULL,
	"company_limit" integer DEFAULT 1 NOT NULL,
	"integration_limit" integer DEFAULT 1 NOT NULL,
	"storage_limit_mb" integer DEFAULT 1024 NOT NULL,
	"features_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stripe_monthly_price_id" text DEFAULT '' NOT NULL,
	"stripe_annual_price_id" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_saas_plans_status_check" CHECK ("fdp_saas_plans"."status" IN ('draft', 'active', 'archived')),
	CONSTRAINT "fdp_saas_plans_currency_check" CHECK ("fdp_saas_plans"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "fdp_saas_plans_prices_check" CHECK ("fdp_saas_plans"."monthly_price_cents" >= 0 AND "fdp_saas_plans"."annual_price_cents" >= 0),
	CONSTRAINT "fdp_saas_plans_limits_check" CHECK ("fdp_saas_plans"."trial_days" BETWEEN 0 AND 90 AND "fdp_saas_plans"."included_seats" > 0 AND "fdp_saas_plans"."company_limit" > 0 AND "fdp_saas_plans"."integration_limit" >= 0 AND "fdp_saas_plans"."storage_limit_mb" > 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_workspace_onboarding" (
	"workspace_id" text PRIMARY KEY DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"current_step" text DEFAULT 'company' NOT NULL,
	"completed_steps_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped_steps_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"profile_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_workspace_onboarding_status_check" CHECK ("fdp_workspace_onboarding"."status" IN ('in_progress', 'completed', 'dismissed')),
	CONSTRAINT "fdp_workspace_onboarding_step_check" CHECK ("fdp_workspace_onboarding"."current_step" IN ('company', 'team', 'operation', 'integrations', 'billing', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "fdp_workspace_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"plan_id" text NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"billing_interval" text DEFAULT 'monthly' NOT NULL,
	"seat_quantity" integer DEFAULT 1 NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"external_customer_id" text DEFAULT '' NOT NULL,
	"external_subscription_id" text DEFAULT '' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_starts_at" timestamp with time zone,
	"current_period_ends_at" timestamp with time zone,
	"cancel_at_period_end" integer DEFAULT 0 NOT NULL,
	"canceled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_workspace_subscriptions_status_check" CHECK ("fdp_workspace_subscriptions"."status" IN ('trialing', 'active', 'past_due', 'paused', 'canceled', 'incomplete')),
	CONSTRAINT "fdp_workspace_subscriptions_interval_check" CHECK ("fdp_workspace_subscriptions"."billing_interval" IN ('monthly', 'annual')),
	CONSTRAINT "fdp_workspace_subscriptions_provider_check" CHECK ("fdp_workspace_subscriptions"."provider" IN ('stripe', 'manual')),
	CONSTRAINT "fdp_workspace_subscriptions_seats_check" CHECK ("fdp_workspace_subscriptions"."seat_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_workspace_usage_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"limit_snapshot" integer DEFAULT 0 NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_workspace_usage_metric_check" CHECK ("fdp_workspace_usage_counters"."metric" IN ('members', 'companies', 'integrations', 'storage_mb')),
	CONSTRAINT "fdp_workspace_usage_quantity_check" CHECK ("fdp_workspace_usage_counters"."quantity" >= 0 AND "fdp_workspace_usage_counters"."limit_snapshot" >= 0)
);
--> statement-breakpoint
ALTER TABLE "fdp_billing_events" ADD CONSTRAINT "fdp_billing_events_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_billing_invoices" ADD CONSTRAINT "fdp_billing_invoices_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_billing_invoices" ADD CONSTRAINT "fdp_billing_invoices_workspace_subscription_fk" FOREIGN KEY ("workspace_id","subscription_id") REFERENCES "public"."fdp_workspace_subscriptions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_platform_audit_events" ADD CONSTRAINT "fdp_platform_audit_events_actor_user_id_fdp_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."fdp_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_onboarding" ADD CONSTRAINT "fdp_workspace_onboarding_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_subscriptions" ADD CONSTRAINT "fdp_workspace_subscriptions_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_subscriptions" ADD CONSTRAINT "fdp_workspace_subscriptions_plan_id_fdp_saas_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."fdp_saas_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_workspace_usage_counters" ADD CONSTRAINT "fdp_workspace_usage_counters_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_billing_events_external_uq" ON "fdp_billing_events" USING btree ("external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_billing_events_workspace_id_uq" ON "fdp_billing_events" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_billing_events_workspace_received_idx" ON "fdp_billing_events" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_billing_invoices_external_uq" ON "fdp_billing_invoices" USING btree ("external_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_billing_invoices_workspace_id_uq" ON "fdp_billing_invoices" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_billing_invoices_workspace_created_idx" ON "fdp_billing_invoices" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "fdp_platform_audit_created_idx" ON "fdp_platform_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "fdp_platform_audit_actor_idx" ON "fdp_platform_audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_saas_plans_code_uq" ON "fdp_saas_plans" USING btree ("code");--> statement-breakpoint
CREATE INDEX "fdp_saas_plans_status_position_idx" ON "fdp_saas_plans" USING btree ("status","position");--> statement-breakpoint
CREATE INDEX "fdp_workspace_onboarding_status_idx" ON "fdp_workspace_onboarding" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspace_subscriptions_workspace_uq" ON "fdp_workspace_subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspace_subscriptions_workspace_id_uq" ON "fdp_workspace_subscriptions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspace_subscriptions_customer_uq" ON "fdp_workspace_subscriptions" USING btree ("external_customer_id") WHERE "fdp_workspace_subscriptions"."external_customer_id" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspace_subscriptions_external_uq" ON "fdp_workspace_subscriptions" USING btree ("external_subscription_id") WHERE "fdp_workspace_subscriptions"."external_subscription_id" <> '';--> statement-breakpoint
CREATE INDEX "fdp_workspace_subscriptions_status_idx" ON "fdp_workspace_subscriptions" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspace_usage_metric_period_uq" ON "fdp_workspace_usage_counters" USING btree ("workspace_id","metric","period");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_workspace_usage_workspace_id_uq" ON "fdp_workspace_usage_counters" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_workspace_usage_period_idx" ON "fdp_workspace_usage_counters" USING btree ("workspace_id","period","metric");--> statement-breakpoint

INSERT INTO "fdp_saas_plans" (
  "id", "code", "name", "description", "status", "currency", "monthly_price_cents", "annual_price_cents",
  "trial_days", "included_seats", "company_limit", "integration_limit", "storage_limit_mb", "features_json", "position"
) VALUES
  ('plan_starter', 'starter', 'Gratuito', 'Base segura para conhecer o Fila DP.', 'active', 'brl', 0, 0, 0, 3, 1, 1, 1024, '["quadros", "cadastros", "operacao_dp"]'::jsonb, 100),
  ('plan_standard', 'standard', 'Standard', 'Operação recorrente para equipes de DP.', 'draft', 'brl', 0, 0, 14, 10, 5, 3, 5120, '["quadros", "cadastros", "operacao_dp", "modulos_auxiliares", "integracoes"]'::jsonb, 200),
  ('plan_premium', 'premium', 'Premium', 'Escala, controles e integrações ampliadas.', 'draft', 'brl', 0, 0, 14, 30, 20, 10, 20480, '["quadros", "cadastros", "operacao_dp", "modulos_auxiliares", "integracoes", "auditoria_avancada"]'::jsonb, 300),
  ('plan_enterprise', 'enterprise', 'Enterprise', 'Contrato e limites personalizados.', 'draft', 'brl', 0, 0, 30, 100, 100, 50, 102400, '["quadros", "cadastros", "operacao_dp", "modulos_auxiliares", "integracoes", "auditoria_avancada", "suporte_prioritario"]'::jsonb, 400)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

INSERT INTO "fdp_workspace_subscriptions" (
  "id", "workspace_id", "plan_id", "status", "billing_interval", "seat_quantity", "provider"
)
SELECT 'subscription_' || workspace."id", workspace."id", 'plan_starter', 'active', 'monthly',
       GREATEST(1, (SELECT COUNT(*)::integer FROM "fdp_workspace_members" member WHERE member."workspace_id" = workspace."id")),
       'manual'
FROM "fdp_workspaces" workspace
ON CONFLICT ("workspace_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "fdp_workspace_onboarding" (
  "workspace_id", "status", "current_step", "completed_steps_json"
)
SELECT workspace."id", 'in_progress',
       CASE WHEN EXISTS (SELECT 1 FROM "fdp_companies" company WHERE company."workspace_id" = workspace."id") THEN 'team' ELSE 'company' END,
       CASE WHEN EXISTS (SELECT 1 FROM "fdp_companies" company WHERE company."workspace_id" = workspace."id") THEN '["company"]'::jsonb ELSE '[]'::jsonb END
FROM "fdp_workspaces" workspace
ON CONFLICT ("workspace_id") DO NOTHING;--> statement-breakpoint

ALTER TABLE "fdp_workspace_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_workspace_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_workspace_subscriptions_workspace_isolation" ON "fdp_workspace_subscriptions"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
CREATE POLICY "fdp_workspace_subscriptions_platform_read" ON "fdp_workspace_subscriptions" FOR SELECT
  USING (current_setting('app.platform_admin', true) = 'true');--> statement-breakpoint

ALTER TABLE "fdp_workspace_onboarding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_workspace_onboarding" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_workspace_onboarding_workspace_isolation" ON "fdp_workspace_onboarding"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
CREATE POLICY "fdp_workspace_onboarding_platform_read" ON "fdp_workspace_onboarding" FOR SELECT
  USING (current_setting('app.platform_admin', true) = 'true');--> statement-breakpoint

ALTER TABLE "fdp_workspace_usage_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_workspace_usage_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_workspace_usage_workspace_isolation" ON "fdp_workspace_usage_counters"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
CREATE POLICY "fdp_workspace_usage_platform_read" ON "fdp_workspace_usage_counters" FOR SELECT
  USING (current_setting('app.platform_admin', true) = 'true');--> statement-breakpoint

ALTER TABLE "fdp_billing_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_billing_invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_billing_invoices_workspace_isolation" ON "fdp_billing_invoices"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
CREATE POLICY "fdp_billing_invoices_platform_read" ON "fdp_billing_invoices" FOR SELECT
  USING (current_setting('app.platform_admin', true) = 'true');--> statement-breakpoint

ALTER TABLE "fdp_billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_billing_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_billing_events_workspace_isolation" ON "fdp_billing_events"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
CREATE POLICY "fdp_billing_events_platform_read" ON "fdp_billing_events" FOR SELECT
  USING (current_setting('app.platform_admin', true) = 'true');--> statement-breakpoint

ALTER TABLE "fdp_platform_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_platform_audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_platform_audit_access" ON "fdp_platform_audit_events"
  USING (current_setting('app.platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.platform_admin', true) = 'true');--> statement-breakpoint

CREATE OR REPLACE FUNCTION fdp_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append-only record cannot be updated or deleted';
END;
$$;--> statement-breakpoint

CREATE TRIGGER fdp_billing_events_append_only
BEFORE UPDATE OR DELETE ON "fdp_billing_events"
FOR EACH ROW EXECUTE FUNCTION fdp_reject_append_only_mutation();--> statement-breakpoint

CREATE TRIGGER fdp_platform_audit_append_only
BEFORE UPDATE OR DELETE ON "fdp_platform_audit_events"
FOR EACH ROW EXECUTE FUNCTION fdp_reject_append_only_mutation();
