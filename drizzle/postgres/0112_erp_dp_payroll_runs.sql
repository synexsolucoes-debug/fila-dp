-- ERP DP: folha da competência gravada (docs/engenharia-reversa-sap-hcm.md
-- §18, item 10 do roadmap).
--
-- A folha é calculada para a empresa inteira numa competência que existe em
-- `fdp_payroll_cycles`, e o resultado de cada colaborador é gravado com as
-- rubricas e as entradas que o compuseram (ponto, parcelas, retroativos).
-- Recalcular substitui o resultado enquanto a folha está aberta; fechada, ela
-- não muda mais — o que mudar depois vira diferença retroativa na próxima.
--
-- Valores em centavos. A remuneração ganha o custo do vale-transporte e a
-- coparticipação do vale-refeição, que a folha desconta.
SELECT pg_advisory_xact_lock(hashtext('0112_erp_dp_payroll_runs'));
--> statement-breakpoint

ALTER TABLE "fdp_employee_remuneration" ADD COLUMN "transport_voucher_cents" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD COLUMN "meal_voucher_discount_cents" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD CONSTRAINT "fdp_employee_remuneration_vouchers_check"
  CHECK ("transport_voucher_cents" >= 0 AND "meal_voucher_discount_cents" >= 0);
--> statement-breakpoint

CREATE TABLE "fdp_payroll_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"payroll_cycle_id" text NOT NULL,
	"competence" text NOT NULL,
	"status" text DEFAULT 'calculated' NOT NULL,
	-- Quantas vezes foi calculada: cada recálculo soma um.
	"calculation_count" integer DEFAULT 1 NOT NULL,
	"employees_count" integer DEFAULT 0 NOT NULL,
	"earnings_cents" bigint DEFAULT 0 NOT NULL,
	"deductions_cents" bigint DEFAULT 0 NOT NULL,
	"net_cents" bigint DEFAULT 0 NOT NULL,
	"fgts_cents" bigint DEFAULT 0 NOT NULL,
	-- Quem ficou de fora e por quê (afastado, desligado, sem remuneração).
	"skipped_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculated_by" text NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_payroll_runs_status_check" CHECK ("status" IN ('calculated', 'closed')),
	CONSTRAINT "fdp_payroll_runs_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_payroll_runs_closed_check" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL AND "closed_by" IS NOT NULL)),
	CONSTRAINT "fdp_payroll_runs_totals_check" CHECK ("net_cents" = "earnings_cents" - "deductions_cents" AND "employees_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_runs_workspace_id_uq" ON "fdp_payroll_runs" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- Uma folha mensal por competência de cada empresa.
CREATE UNIQUE INDEX "fdp_payroll_runs_cycle_uq" ON "fdp_payroll_runs" USING btree ("workspace_id", "payroll_cycle_id");
--> statement-breakpoint
CREATE INDEX "fdp_payroll_runs_company_competence_idx" ON "fdp_payroll_runs" USING btree ("workspace_id", "company_id", "competence");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_runs" ADD CONSTRAINT "fdp_payroll_runs_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_runs" ADD CONSTRAINT "fdp_payroll_runs_cycle_fk"
  FOREIGN KEY ("workspace_id", "company_id", "payroll_cycle_id") REFERENCES "public"."fdp_payroll_cycles"("workspace_id", "company_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_payroll_runs_workspace_isolation" ON "fdp_payroll_runs"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

CREATE TABLE "fdp_payroll_results" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"run_id" text NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"competence" text NOT NULL,
	"salary_cents" bigint NOT NULL,
	"earnings_cents" bigint NOT NULL,
	"deductions_cents" bigint NOT NULL,
	"net_cents" bigint NOT NULL,
	"fgts_cents" bigint NOT NULL,
	"lines_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- De onde veio cada entrada: folha de ponto, parcelas, retroativos.
	"inputs_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_payroll_results_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_payroll_results_totals_check" CHECK ("net_cents" = "earnings_cents" - "deductions_cents"),
	CONSTRAINT "fdp_payroll_results_lines_check" CHECK (jsonb_typeof("lines_json") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_results_workspace_id_uq" ON "fdp_payroll_results" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_results_run_employee_uq" ON "fdp_payroll_results" USING btree ("workspace_id", "run_id", "employee_id");
--> statement-breakpoint
-- A média de variáveis lê as folhas da pessoa por competência.
CREATE INDEX "fdp_payroll_results_employee_competence_idx" ON "fdp_payroll_results" USING btree ("workspace_id", "employee_id", "competence");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_results" ADD CONSTRAINT "fdp_payroll_results_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_results" ADD CONSTRAINT "fdp_payroll_results_run_fk"
  FOREIGN KEY ("workspace_id", "run_id") REFERENCES "public"."fdp_payroll_runs"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_results" ADD CONSTRAINT "fdp_payroll_results_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_results" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_payroll_results_workspace_isolation" ON "fdp_payroll_results"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
