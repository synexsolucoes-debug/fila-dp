-- Conferência de ponto (§28) e mapeamento de eventos de hora (§22).
-- Migration aditiva: nenhuma tabela existente é removida ou reescrita.
--
-- A regra do §22 aparece aqui como CHECK: um evento do tipo hora só pode
-- apontar para quantidade, referência ou índice. "valor" não é um destino
-- desabilitado — ele não é representável nesta coluna.
CREATE TABLE "fdp_hour_event_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"destination" text NOT NULL,
	"event_code" text NOT NULL,
	"rubric_code" text NOT NULL,
	"target_field" text NOT NULL,
	"unit" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_hour_event_mappings_event_check" CHECK ("fdp_hour_event_mappings"."event_code" IN ('overtime_50', 'overtime_100', 'night_hours', 'late_hours', 'absence_hours', 'interval_not_taken', 'on_call_hours', 'time_bank_credit', 'time_bank_debit')),
	CONSTRAINT "fdp_hour_event_mappings_target_check" CHECK ("fdp_hour_event_mappings"."target_field" IN ('quantity', 'reference', 'index')),
	CONSTRAINT "fdp_hour_event_mappings_unit_check" CHECK ("fdp_hour_event_mappings"."unit" IN ('hours_decimal', 'hours_minutes', 'minutes')),
	CONSTRAINT "fdp_hour_event_mappings_status_check" CHECK ("fdp_hour_event_mappings"."status" IN ('active', 'inactive')),
	CONSTRAINT "fdp_hour_event_mappings_rubric_check" CHECK (length("fdp_hour_event_mappings"."rubric_code") > 0),
	CONSTRAINT "fdp_hour_event_mappings_destination_check" CHECK (length("fdp_hour_event_mappings"."destination") > 0)
);
--> statement-breakpoint
CREATE TABLE "fdp_time_sheets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"competence" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"entries_count" integer DEFAULT 0 NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"expected_minutes" integer DEFAULT 0 NOT NULL,
	"balance_minutes" integer DEFAULT 0 NOT NULL,
	"blocking_issues" integer DEFAULT 0 NOT NULL,
	"warning_issues" integer DEFAULT 0 NOT NULL,
	"calc_version" text NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_reason" text DEFAULT '' NOT NULL,
	"exported_at" timestamp with time zone,
	"export_id" text,
	"reopen_reason" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_time_sheets_competence_check" CHECK ("fdp_time_sheets"."competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_time_sheets_status_check" CHECK ("fdp_time_sheets"."status" IN ('draft', 'review', 'approved', 'rejected', 'exported', 'closed')),
	CONSTRAINT "fdp_time_sheets_source_check" CHECK ("fdp_time_sheets"."source" IN ('manual', 'import', 'integration')),
	CONSTRAINT "fdp_time_sheets_count_check" CHECK ("fdp_time_sheets"."entries_count" >= 0 AND "fdp_time_sheets"."blocking_issues" >= 0 AND "fdp_time_sheets"."warning_issues" >= 0),
	CONSTRAINT "fdp_time_sheets_minutes_check" CHECK ("fdp_time_sheets"."worked_minutes" >= 0 AND "fdp_time_sheets"."expected_minutes" >= 0),
	CONSTRAINT "fdp_time_sheets_balance_check" CHECK ("fdp_time_sheets"."balance_minutes" = "fdp_time_sheets"."worked_minutes" - "fdp_time_sheets"."expected_minutes"),
	CONSTRAINT "fdp_time_sheets_approved_check" CHECK ("fdp_time_sheets"."status" NOT IN ('approved', 'exported', 'closed') OR "fdp_time_sheets"."approved_by" IS NOT NULL),
	CONSTRAINT "fdp_time_sheets_export_check" CHECK ("fdp_time_sheets"."status" <> 'exported' OR "fdp_time_sheets"."export_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "fdp_time_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"time_sheet_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"entry_date" date NOT NULL,
	"day_type" text DEFAULT 'regular' NOT NULL,
	"expected_minutes" integer DEFAULT 0 NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"night_minutes" integer DEFAULT 0 NOT NULL,
	"balance_minutes" integer DEFAULT 0 NOT NULL,
	"punches_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"justification" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_time_entries_day_type_check" CHECK ("fdp_time_entries"."day_type" IN ('regular', 'rest', 'holiday', 'vacation', 'leave', 'absence')),
	CONSTRAINT "fdp_time_entries_origin_check" CHECK ("fdp_time_entries"."origin" IN ('manual', 'import', 'integration')),
	CONSTRAINT "fdp_time_entries_minutes_check" CHECK ("fdp_time_entries"."expected_minutes" >= 0 AND "fdp_time_entries"."worked_minutes" >= 0 AND "fdp_time_entries"."night_minutes" >= 0 AND "fdp_time_entries"."worked_minutes" <= 1440 AND "fdp_time_entries"."expected_minutes" <= 1440),
	CONSTRAINT "fdp_time_entries_night_check" CHECK ("fdp_time_entries"."night_minutes" <= "fdp_time_entries"."worked_minutes"),
	CONSTRAINT "fdp_time_entries_balance_check" CHECK ("fdp_time_entries"."balance_minutes" = "fdp_time_entries"."worked_minutes" - "fdp_time_entries"."expected_minutes"),
	CONSTRAINT "fdp_time_entries_punches_check" CHECK (jsonb_typeof("fdp_time_entries"."punches_json") = 'array' AND jsonb_array_length("fdp_time_entries"."punches_json") <= 12)
);
--> statement-breakpoint
CREATE TABLE "fdp_time_sheet_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"time_sheet_id" text NOT NULL,
	"event_code" text NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'computed' NOT NULL,
	"justification" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_time_sheet_events_event_check" CHECK ("fdp_time_sheet_events"."event_code" IN ('overtime_50', 'overtime_100', 'night_hours', 'late_hours', 'absence_hours', 'interval_not_taken', 'on_call_hours', 'time_bank_credit', 'time_bank_debit')),
	CONSTRAINT "fdp_time_sheet_events_source_check" CHECK ("fdp_time_sheet_events"."source" IN ('computed', 'manual')),
	CONSTRAINT "fdp_time_sheet_events_minutes_check" CHECK ("fdp_time_sheet_events"."minutes" >= 0),
	CONSTRAINT "fdp_time_sheet_events_justification_check" CHECK ("fdp_time_sheet_events"."source" <> 'manual' OR length("fdp_time_sheet_events"."justification") >= 5)
);
--> statement-breakpoint
CREATE TABLE "fdp_time_inconsistencies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"time_sheet_id" text NOT NULL,
	"entry_date" date,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text DEFAULT '' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_time_inconsistencies_kind_check" CHECK ("fdp_time_inconsistencies"."kind" IN ('missing_punch', 'odd_punch_count', 'duplicate_punch', 'out_of_order_punch', 'missing_schedule', 'future_date', 'work_on_non_working_day', 'overtime_without_justification', 'interval_below_minimum')),
	CONSTRAINT "fdp_time_inconsistencies_severity_check" CHECK ("fdp_time_inconsistencies"."severity" IN ('blocking', 'warning')),
	CONSTRAINT "fdp_time_inconsistencies_status_check" CHECK ("fdp_time_inconsistencies"."status" IN ('open', 'resolved', 'waived')),
	CONSTRAINT "fdp_time_inconsistencies_resolution_check" CHECK ("fdp_time_inconsistencies"."status" = 'open' OR length("fdp_time_inconsistencies"."resolution_note") >= 5)
);
--> statement-breakpoint
CREATE TABLE "fdp_time_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"competence" text NOT NULL,
	"destination" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"sheets_count" integer DEFAULT 0 NOT NULL,
	"lines_count" integer DEFAULT 0 NOT NULL,
	"checksum" text NOT NULL,
	"payload_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_time_exports_competence_check" CHECK ("fdp_time_exports"."competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_time_exports_status_check" CHECK ("fdp_time_exports"."status" IN ('prepared', 'delivered', 'failed')),
	CONSTRAINT "fdp_time_exports_count_check" CHECK ("fdp_time_exports"."sheets_count" >= 0 AND "fdp_time_exports"."lines_count" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_hour_event_mappings_workspace_id_uq" ON "fdp_hour_event_mappings" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_hour_event_mappings_scope_event_uq" ON "fdp_hour_event_mappings" USING btree ("workspace_id","company_id","destination","event_code");--> statement-breakpoint
CREATE INDEX "fdp_hour_event_mappings_workspace_status_idx" ON "fdp_hour_event_mappings" USING btree ("workspace_id","company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_exports_workspace_id_uq" ON "fdp_time_exports" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "fdp_time_exports_workspace_cycle_idx" ON "fdp_time_exports" USING btree ("workspace_id","payroll_cycle_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_sheets_workspace_id_uq" ON "fdp_time_sheets" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_sheets_workspace_employee_cycle_uq" ON "fdp_time_sheets" USING btree ("workspace_id","employee_id","payroll_cycle_id");--> statement-breakpoint
CREATE INDEX "fdp_time_sheets_workspace_status_idx" ON "fdp_time_sheets" USING btree ("workspace_id","competence","status");--> statement-breakpoint
CREATE INDEX "fdp_time_sheets_workspace_company_cycle_idx" ON "fdp_time_sheets" USING btree ("workspace_id","company_id","payroll_cycle_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_entries_workspace_id_uq" ON "fdp_time_entries" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_entries_sheet_date_uq" ON "fdp_time_entries" USING btree ("workspace_id","time_sheet_id","entry_date");--> statement-breakpoint
CREATE INDEX "fdp_time_entries_workspace_employee_idx" ON "fdp_time_entries" USING btree ("workspace_id","employee_id","entry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_sheet_events_workspace_id_uq" ON "fdp_time_sheet_events" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_sheet_events_sheet_event_uq" ON "fdp_time_sheet_events" USING btree ("workspace_id","time_sheet_id","event_code");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_inconsistencies_workspace_id_uq" ON "fdp_time_inconsistencies" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_time_inconsistencies_sheet_kind_uq" ON "fdp_time_inconsistencies" USING btree ("workspace_id","time_sheet_id",(coalesce("entry_date", DATE '1900-01-01')),"kind");--> statement-breakpoint
CREATE INDEX "fdp_time_inconsistencies_workspace_status_idx" ON "fdp_time_inconsistencies" USING btree ("workspace_id","status","severity");
--> statement-breakpoint
ALTER TABLE "fdp_hour_event_mappings" ADD CONSTRAINT "fdp_hour_event_mappings_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_hour_event_mappings" ADD CONSTRAINT "fdp_hour_event_mappings_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_hour_event_mappings" ADD CONSTRAINT "fdp_hour_event_mappings_workspace_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_hour_event_mappings" ADD CONSTRAINT "fdp_hour_event_mappings_workspace_author_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_exports" ADD CONSTRAINT "fdp_time_exports_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_exports" ADD CONSTRAINT "fdp_time_exports_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_exports" ADD CONSTRAINT "fdp_time_exports_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_exports" ADD CONSTRAINT "fdp_time_exports_workspace_author_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_company_id_fdp_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."fdp_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_employee_id_fdp_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."fdp_employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_workspace_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_workspace_cycle_fk" FOREIGN KEY ("workspace_id","company_id","payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_workspace_approver_fk" FOREIGN KEY ("workspace_id","approved_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ADD CONSTRAINT "fdp_time_sheets_workspace_export_fk" FOREIGN KEY ("workspace_id","export_id") REFERENCES "public"."fdp_time_exports"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_entries" ADD CONSTRAINT "fdp_time_entries_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_entries" ADD CONSTRAINT "fdp_time_entries_time_sheet_id_fdp_time_sheets_id_fk" FOREIGN KEY ("time_sheet_id") REFERENCES "public"."fdp_time_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_entries" ADD CONSTRAINT "fdp_time_entries_workspace_sheet_fk" FOREIGN KEY ("workspace_id","time_sheet_id") REFERENCES "public"."fdp_time_sheets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_entries" ADD CONSTRAINT "fdp_time_entries_workspace_employee_fk" FOREIGN KEY ("workspace_id","company_id","employee_id") REFERENCES "public"."fdp_employees"("workspace_id","company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheet_events" ADD CONSTRAINT "fdp_time_sheet_events_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheet_events" ADD CONSTRAINT "fdp_time_sheet_events_time_sheet_id_fdp_time_sheets_id_fk" FOREIGN KEY ("time_sheet_id") REFERENCES "public"."fdp_time_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_sheet_events" ADD CONSTRAINT "fdp_time_sheet_events_workspace_sheet_fk" FOREIGN KEY ("workspace_id","time_sheet_id") REFERENCES "public"."fdp_time_sheets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_inconsistencies" ADD CONSTRAINT "fdp_time_inconsistencies_workspace_id_fdp_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_inconsistencies" ADD CONSTRAINT "fdp_time_inconsistencies_time_sheet_id_fdp_time_sheets_id_fk" FOREIGN KEY ("time_sheet_id") REFERENCES "public"."fdp_time_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_inconsistencies" ADD CONSTRAINT "fdp_time_inconsistencies_workspace_sheet_fk" FOREIGN KEY ("workspace_id","time_sheet_id") REFERENCES "public"."fdp_time_sheets"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_time_inconsistencies" ADD CONSTRAINT "fdp_time_inconsistencies_workspace_resolver_fk" FOREIGN KEY ("workspace_id","resolved_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_hour_event_mappings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_hour_event_mappings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_sheets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_sheet_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_sheet_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_inconsistencies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_inconsistencies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_exports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_time_exports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_hour_event_mappings_workspace_isolation" ON "fdp_hour_event_mappings"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_time_sheets_workspace_isolation" ON "fdp_time_sheets"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_time_entries_workspace_isolation" ON "fdp_time_entries"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_time_sheet_events_workspace_isolation" ON "fdp_time_sheet_events"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_time_inconsistencies_workspace_isolation" ON "fdp_time_inconsistencies"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
CREATE POLICY "fdp_time_exports_workspace_isolation" ON "fdp_time_exports"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
-- Ponto exportado é prova documental: os totais apurados e a identidade da folha
-- congelam, e voltar atrás exige justificativa registrada.
CREATE OR REPLACE FUNCTION "fdp_time_sheet_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('exported', 'closed') THEN
      RAISE EXCEPTION 'exported time sheet is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('exported', 'closed') THEN
    IF NEW.worked_minutes IS DISTINCT FROM OLD.worked_minutes
      OR NEW.expected_minutes IS DISTINCT FROM OLD.expected_minutes
      OR NEW.balance_minutes IS DISTINCT FROM OLD.balance_minutes
      OR NEW.calc_version IS DISTINCT FROM OLD.calc_version
      OR NEW.competence IS DISTINCT FROM OLD.competence
      OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
      OR NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.payroll_cycle_id IS DISTINCT FROM OLD.payroll_cycle_id THEN
      RAISE EXCEPTION 'exported time sheet is immutable';
    END IF;
    -- O snapshot é escrito uma única vez, no fechamento definitivo da folha.
    IF OLD.status = 'closed' AND NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json THEN
      RAISE EXCEPTION 'exported time sheet is immutable';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'exported' AND NEW.status = 'closed')
      OR (NEW.status = 'review' AND length(coalesce(NEW.reopen_reason, '')) >= 5)
    ) THEN
      RAISE EXCEPTION 'reopening an exported time sheet requires a justification';
    END IF;
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_time_sheets_guard"
BEFORE UPDATE OR DELETE ON "fdp_time_sheets"
FOR EACH ROW EXECUTE FUNCTION "fdp_time_sheet_guard"();
--> statement-breakpoint
-- Marcações e eventos de uma folha exportada acompanham o congelamento: o
-- que foi enviado à folha continua igual ao que está gravado aqui.
CREATE OR REPLACE FUNCTION "fdp_time_child_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked boolean;
  target text;
BEGIN
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.time_sheet_id ELSE NEW.time_sheet_id END;
  SELECT status IN ('exported', 'closed') INTO locked FROM fdp_time_sheets WHERE id = target;
  IF coalesce(locked, false) THEN
    RAISE EXCEPTION 'entry of an exported time sheet is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_time_entries_guard"
BEFORE UPDATE OR DELETE ON "fdp_time_entries"
FOR EACH ROW EXECUTE FUNCTION "fdp_time_child_guard"();
--> statement-breakpoint
CREATE TRIGGER "fdp_time_sheet_events_guard"
BEFORE UPDATE OR DELETE ON "fdp_time_sheet_events"
FOR EACH ROW EXECUTE FUNCTION "fdp_time_child_guard"();
--> statement-breakpoint
-- Um lote de exportação é registro do que saiu: só o estado de entrega muda.
CREATE OR REPLACE FUNCTION "fdp_time_export_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'time export batches are append-only';
  END IF;
  IF NEW.payload_json IS DISTINCT FROM OLD.payload_json
    OR NEW.checksum IS DISTINCT FROM OLD.checksum
    OR NEW.lines_count IS DISTINCT FROM OLD.lines_count
    OR NEW.competence IS DISTINCT FROM OLD.competence
    OR NEW.destination IS DISTINCT FROM OLD.destination THEN
    RAISE EXCEPTION 'time export batches are append-only';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fdp_time_exports_guard"
BEFORE UPDATE OR DELETE ON "fdp_time_exports"
FOR EACH ROW EXECUTE FUNCTION "fdp_time_export_guard"();
