-- DP Operacional, Fases 2 a 5 (docs/arquitetura-operacional.md §4.34 a §4.37).
--
-- Fase 2 — rotinas fixas do mês viram demandas geradas por competência
-- (modelos recorrentes). Fase 3 — regra de corte por tipo de processo,
-- registro de quem pediu fora do prazo (ocorrências). Fase 4 — alertas de
-- experiência, férias e cadastro calculados dos dados do Sankhya. Fase 5 —
-- registro do relatório mensal enviado à gestão.
--
-- Todas as tabelas novas seguem o padrão do projeto: `workspace_id` com o
-- tenant da sessão como default e RLS forçada.
SELECT pg_advisory_xact_lock(hashtext('0115_dp_operations'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Configuração do DP Operacional por workspace
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fdp_dp_settings" (
	"workspace_id" text PRIMARY KEY DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	-- Responsável pelas rotinas de escopo "grupo" (uma tarefa só para o tenant).
	"tenant_task_owner_user_id" text,
	-- Destinatários do relatório mensal, separados por vírgula.
	"report_recipients" text DEFAULT '' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_dp_settings_recipients_check" CHECK (length("report_recipients") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "fdp_dp_settings" DROP CONSTRAINT IF EXISTS "fdp_dp_settings_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_settings" ADD CONSTRAINT "fdp_dp_settings_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_dp_settings" DROP CONSTRAINT IF EXISTS "fdp_dp_settings_owner_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_settings" ADD CONSTRAINT "fdp_dp_settings_owner_fk"
  FOREIGN KEY ("tenant_task_owner_user_id") REFERENCES "public"."fdp_users"("id");
--> statement-breakpoint
ALTER TABLE "fdp_dp_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_dp_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_dp_settings_workspace_isolation" ON "fdp_dp_settings";
--> statement-breakpoint
CREATE POLICY "fdp_dp_settings_workspace_isolation" ON "fdp_dp_settings"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Fase 2: modelos recorrentes e o que cada um já gerou
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fdp_recurring_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"frequency" text NOT NULL,
	-- Janela no mês (1–31; 31 = último dia). Na semanal, só `weekday` vale.
	"day_start" integer DEFAULT 1 NOT NULL,
	"day_end" integer DEFAULT 1 NOT NULL,
	-- 0 = domingo … 6 = sábado (o mesmo de Date.getUTCDay).
	"weekday" integer,
	"scope" text NOT NULL,
	-- Lista de empresas; NULL = todas com dp_status = 'interno'.
	"company_ids" jsonb,
	"process_type" text DEFAULT 'ROTINA DP' NOT NULL,
	-- A tarefa lista as admissões e desligamentos da semana (Wellhub).
	"list_week_movements" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_recurring_templates_frequency_check" CHECK ("frequency" IN ('monthly', 'weekly')),
	CONSTRAINT "fdp_recurring_templates_scope_check" CHECK ("scope" IN ('company', 'cnpj_root', 'tenant')),
	CONSTRAINT "fdp_recurring_templates_days_check" CHECK ("day_start" BETWEEN 1 AND 31 AND "day_end" BETWEEN 1 AND 31 AND "day_start" <= "day_end"),
	CONSTRAINT "fdp_recurring_templates_weekday_check" CHECK (("frequency" = 'weekly') = ("weekday" IS NOT NULL) AND ("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6)),
	CONSTRAINT "fdp_recurring_templates_companies_check" CHECK ("company_ids" IS NULL OR jsonb_typeof("company_ids") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_recurring_templates_workspace_id_uq" ON "fdp_recurring_templates" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_recurring_templates_code_uq" ON "fdp_recurring_templates" USING btree ("workspace_id", "code");
--> statement-breakpoint
ALTER TABLE "fdp_recurring_templates" DROP CONSTRAINT IF EXISTS "fdp_recurring_templates_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_recurring_templates" ADD CONSTRAINT "fdp_recurring_templates_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_recurring_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_recurring_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_recurring_templates_workspace_isolation" ON "fdp_recurring_templates";
--> statement-breakpoint
CREATE POLICY "fdp_recurring_templates_workspace_isolation" ON "fdp_recurring_templates"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- Uma demanda por modelo, período e escopo: é o índice único que impede o job
-- diário de gerar a mesma rotina duas vezes.
CREATE TABLE IF NOT EXISTS "fdp_recurring_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"template_id" text NOT NULL,
	-- AAAA-MM na mensal; AAAA-MM-DD (segunda-feira) na semanal.
	"period_key" text NOT NULL,
	-- id da empresa, raiz do CNPJ (`raiz:12345678`) ou `grupo`.
	"scope_key" text NOT NULL,
	"company_id" text,
	"card_id" text NOT NULL,
	"due_date" date NOT NULL,
	"start_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_recurring_occurrences_workspace_id_uq" ON "fdp_recurring_occurrences" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_recurring_occurrences_once_uq" ON "fdp_recurring_occurrences" USING btree ("workspace_id", "template_id", "period_key", "scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_recurring_occurrences_due_idx" ON "fdp_recurring_occurrences" USING btree ("workspace_id", "due_date");
--> statement-breakpoint
ALTER TABLE "fdp_recurring_occurrences" DROP CONSTRAINT IF EXISTS "fdp_recurring_occurrences_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_recurring_occurrences" ADD CONSTRAINT "fdp_recurring_occurrences_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_recurring_occurrences" DROP CONSTRAINT IF EXISTS "fdp_recurring_occurrences_template_fk";
--> statement-breakpoint
ALTER TABLE "fdp_recurring_occurrences" ADD CONSTRAINT "fdp_recurring_occurrences_template_fk"
  FOREIGN KEY ("workspace_id", "template_id") REFERENCES "public"."fdp_recurring_templates"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_recurring_occurrences" DROP CONSTRAINT IF EXISTS "fdp_recurring_occurrences_card_fk";
--> statement-breakpoint
ALTER TABLE "fdp_recurring_occurrences" ADD CONSTRAINT "fdp_recurring_occurrences_card_fk"
  FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_recurring_occurrences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_recurring_occurrences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_recurring_occurrences_workspace_isolation" ON "fdp_recurring_occurrences";
--> statement-breakpoint
CREATE POLICY "fdp_recurring_occurrences_workspace_isolation" ON "fdp_recurring_occurrences"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Fase 3: regra de corte e ocorrências
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fdp_cutoff_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	-- Tipos de processo da demanda a que a regra se aplica (fdp_cards.process_type).
	"process_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	-- Janela do mês além da antecedência (admissão: até o dia 26).
	"month_day_limit" integer,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'proposta' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_cutoff_rules_kind_check" CHECK ("kind" IN ('antecedencia_dias_uteis', 'antecedencia_dias_corridos', 'dia_do_mes', 'mesmo_dia', 'ate_dias_apos')),
	CONSTRAINT "fdp_cutoff_rules_status_check" CHECK ("status" IN ('proposta', 'aprovada', 'divulgada')),
	CONSTRAINT "fdp_cutoff_rules_value_check" CHECK ("value" >= 0 AND "value" <= 366),
	CONSTRAINT "fdp_cutoff_rules_month_day_check" CHECK ("month_day_limit" IS NULL OR "month_day_limit" BETWEEN 1 AND 31),
	CONSTRAINT "fdp_cutoff_rules_types_check" CHECK (jsonb_typeof("process_types") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_cutoff_rules_workspace_id_uq" ON "fdp_cutoff_rules" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_cutoff_rules_code_uq" ON "fdp_cutoff_rules" USING btree ("workspace_id", "code");
--> statement-breakpoint
ALTER TABLE "fdp_cutoff_rules" DROP CONSTRAINT IF EXISTS "fdp_cutoff_rules_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_cutoff_rules" ADD CONSTRAINT "fdp_cutoff_rules_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_cutoff_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_cutoff_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_cutoff_rules_workspace_isolation" ON "fdp_cutoff_rules";
--> statement-breakpoint
CREATE POLICY "fdp_cutoff_rules_workspace_isolation" ON "fdp_cutoff_rules"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- O corte é decidido na criação e não muda depois: a demanda guarda o veredito
-- e o que foi comparado (data pedida, área que pediu).
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "within_cutoff" boolean;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "requested_for" date;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "requester_area_label" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "cutoff_rule_code" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_requester_area_label_check";
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_requester_area_label_check" CHECK (length("requester_area_label") <= 120);
--> statement-breakpoint
-- Veredito imutável: quem perdeu o prazo não passa a ter cumprido por edição.
CREATE OR REPLACE FUNCTION "fdp_cards_cutoff_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."within_cutoff" IS NOT NULL AND NEW."within_cutoff" IS DISTINCT FROM OLD."within_cutoff" THEN
    RAISE EXCEPTION 'fdp_cards.within_cutoff é decidido na criação e não muda';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "fdp_cards_cutoff_immutable" ON "fdp_cards";
--> statement-breakpoint
CREATE TRIGGER "fdp_cards_cutoff_immutable" BEFORE UPDATE OF "within_cutoff" ON "fdp_cards"
  FOR EACH ROW EXECUTE FUNCTION "fdp_cards_cutoff_immutable"();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_cards_workspace_cutoff_idx" ON "fdp_cards" USING btree ("workspace_id", "created_at") WHERE "within_cutoff" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_dp_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"occurred_on" date NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"company_id" text,
	"card_id" text,
	"fact" text NOT NULL,
	"impact" text DEFAULT '' NOT NULL,
	"origin" text NOT NULL,
	-- Dias de atraso em relação ao corte (automática).
	"days_late" integer,
	"registered_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_dp_occurrences_origin_check" CHECK ("origin" IN ('automatica', 'manual')),
	CONSTRAINT "fdp_dp_occurrences_text_check" CHECK (length("fact") BETWEEN 1 AND 1000 AND length("impact") <= 1000 AND length("area") <= 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_dp_occurrences_workspace_id_uq" ON "fdp_dp_occurrences" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_dp_occurrences_period_idx" ON "fdp_dp_occurrences" USING btree ("workspace_id", "occurred_on");
--> statement-breakpoint
-- Uma ocorrência automática por demanda.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_dp_occurrences_card_auto_uq" ON "fdp_dp_occurrences" USING btree ("workspace_id", "card_id") WHERE "origin" = 'automatica' AND "card_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_dp_occurrences" DROP CONSTRAINT IF EXISTS "fdp_dp_occurrences_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_occurrences" ADD CONSTRAINT "fdp_dp_occurrences_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_dp_occurrences" DROP CONSTRAINT IF EXISTS "fdp_dp_occurrences_company_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_occurrences" ADD CONSTRAINT "fdp_dp_occurrences_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_dp_occurrences" DROP CONSTRAINT IF EXISTS "fdp_dp_occurrences_card_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_occurrences" ADD CONSTRAINT "fdp_dp_occurrences_card_fk"
  FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_dp_occurrences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_dp_occurrences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_dp_occurrences_workspace_isolation" ON "fdp_dp_occurrences";
--> statement-breakpoint
CREATE POLICY "fdp_dp_occurrences_workspace_isolation" ON "fdp_dp_occurrences"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Fase 4: alertas calculados dos dados do Sankhya
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fdp_dp_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	-- Identidade estável do alerta (tipo + colaborador/empresa + marco): o job
	-- diário atualiza o mesmo alerta em vez de criar outro.
	"alert_key" text NOT NULL,
	"alert_type" text NOT NULL,
	"company_id" text,
	"employee_id" text,
	"due_date" date,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"assigned_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"manager_email" text DEFAULT '' NOT NULL,
	"decision" text,
	"decision_note" text DEFAULT '' NOT NULL,
	"decision_source" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_dp_alerts_type_check" CHECK ("alert_type" IN ('experience_45', 'experience_90', 'vacation_deadline', 'registration_incomplete')),
	CONSTRAINT "fdp_dp_alerts_severity_check" CHECK ("severity" IN ('warning', 'urgent', 'overdue')),
	CONSTRAINT "fdp_dp_alerts_status_check" CHECK ("status" IN ('open', 'answered', 'resolved')),
	CONSTRAINT "fdp_dp_alerts_decision_check" CHECK ("decision" IS NULL OR "decision" IN ('efetivar', 'prorrogar', 'desligar')),
	CONSTRAINT "fdp_dp_alerts_decision_source_check" CHECK ("decision_source" IS NULL OR "decision_source" IN ('teams', 'painel')),
	CONSTRAINT "fdp_dp_alerts_answered_check" CHECK (("status" = 'answered') = ("decision" IS NOT NULL AND "decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_dp_alerts_workspace_id_uq" ON "fdp_dp_alerts" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_dp_alerts_key_uq" ON "fdp_dp_alerts" USING btree ("workspace_id", "alert_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_dp_alerts_open_idx" ON "fdp_dp_alerts" USING btree ("workspace_id", "status", "due_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_dp_alerts_assigned_idx" ON "fdp_dp_alerts" USING btree ("workspace_id", "assigned_user_id") WHERE "status" = 'open';
--> statement-breakpoint
ALTER TABLE "fdp_dp_alerts" DROP CONSTRAINT IF EXISTS "fdp_dp_alerts_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_alerts" ADD CONSTRAINT "fdp_dp_alerts_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_dp_alerts" DROP CONSTRAINT IF EXISTS "fdp_dp_alerts_company_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_alerts" ADD CONSTRAINT "fdp_dp_alerts_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_dp_alerts" DROP CONSTRAINT IF EXISTS "fdp_dp_alerts_employee_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_alerts" ADD CONSTRAINT "fdp_dp_alerts_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_dp_alerts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_dp_alerts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_dp_alerts_workspace_isolation" ON "fdp_dp_alerts";
--> statement-breakpoint
CREATE POLICY "fdp_dp_alerts_workspace_isolation" ON "fdp_dp_alerts"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Fase 5: relatório mensal — um envio por competência
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fdp_dp_report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"period" text NOT NULL,
	"recipients_count" integer DEFAULT 0 NOT NULL,
	"sent_by" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_dp_report_runs_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_dp_report_runs_workspace_id_uq" ON "fdp_dp_report_runs" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_dp_report_runs_period_uq" ON "fdp_dp_report_runs" USING btree ("workspace_id", "period");
--> statement-breakpoint
ALTER TABLE "fdp_dp_report_runs" DROP CONSTRAINT IF EXISTS "fdp_dp_report_runs_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_dp_report_runs" ADD CONSTRAINT "fdp_dp_report_runs_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_dp_report_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_dp_report_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "fdp_dp_report_runs_workspace_isolation" ON "fdp_dp_report_runs";
--> statement-breakpoint
CREATE POLICY "fdp_dp_report_runs_workspace_isolation" ON "fdp_dp_report_runs"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
