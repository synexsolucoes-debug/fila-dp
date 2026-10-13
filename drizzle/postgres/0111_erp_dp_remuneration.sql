-- ERP DP: remuneração do colaborador (o infotipo 0008 do SAP), base do
-- cálculo de folha (docs/engenharia-reversa-sap-hcm.md §18).
--
-- O produto passou a calcular folha dentro do modo ERP DP: a regra que
-- proibia (§28 do benchmark) foi revogada por decisão do produto. O salário
-- vive aqui, com vigência — um aumento é um registro novo que delimita o
-- anterior, e o cálculo de um mês passado usa o salário daquele mês.
--
-- Valores em centavos, inteiros. Nada é apagado: corrigir um registro é
-- regravar o mesmo início de vigência, com trilha na auditoria.
SELECT pg_advisory_xact_lock(hashtext('0111_erp_dp_remuneration'));
--> statement-breakpoint

CREATE TABLE "fdp_employee_remuneration" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"employee_id" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date DEFAULT '9999-12-31' NOT NULL,
	-- Mensalista guarda o salário do mês; horista, o valor da hora.
	"salary_kind" text DEFAULT 'monthly' NOT NULL,
	"amount_cents" bigint NOT NULL,
	-- Horas mensais do contrato: 220 para 44 horas semanais.
	"monthly_hours" integer DEFAULT 220 NOT NULL,
	-- Dependentes para o IRRF (o infotipo 0021 do SAP, só a contagem).
	"irrf_dependents" integer DEFAULT 0 NOT NULL,
	"unhealthy_percent" integer DEFAULT 0 NOT NULL,
	"hazardous" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_employee_remuneration_period_check" CHECK ("valid_to" >= "valid_from"),
	CONSTRAINT "fdp_employee_remuneration_kind_check" CHECK ("salary_kind" IN ('monthly', 'hourly')),
	CONSTRAINT "fdp_employee_remuneration_amount_check" CHECK ("amount_cents" > 0),
	CONSTRAINT "fdp_employee_remuneration_hours_check" CHECK ("monthly_hours" BETWEEN 1 AND 744),
	CONSTRAINT "fdp_employee_remuneration_dependents_check" CHECK ("irrf_dependents" BETWEEN 0 AND 30),
	CONSTRAINT "fdp_employee_remuneration_unhealthy_check" CHECK ("unhealthy_percent" IN (0, 10, 20, 40)),
	-- Insalubridade e periculosidade não se acumulam (CLT art. 193, §2º).
	CONSTRAINT "fdp_employee_remuneration_additional_check" CHECK (NOT ("hazardous" AND "unhealthy_percent" > 0)),
	CONSTRAINT "fdp_employee_remuneration_reason_check" CHECK ("reason" IN ('admission', 'raise', 'promotion', 'collective_agreement', 'merit', 'correction', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employee_remuneration_workspace_id_uq" ON "fdp_employee_remuneration" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- Um registro por início de vigência: regravar o mesmo início é correção.
CREATE UNIQUE INDEX "fdp_employee_remuneration_employee_start_uq" ON "fdp_employee_remuneration" USING btree ("workspace_id", "employee_id", "valid_from");
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD CONSTRAINT "fdp_employee_remuneration_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD CONSTRAINT "fdp_employee_remuneration_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_employee_remuneration_workspace_isolation" ON "fdp_employee_remuneration"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
