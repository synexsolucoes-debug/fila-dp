-- ERP DP: regras que faltavam no cálculo (§4.36 de docs/arquitetura-operacional.md).
--
-- Na remuneração: pró-labore do sócio, filhos para o salário-família e
-- pensão alimentícia por percentual. Na configuração da empresa: o piso
-- salarial da convenção coletiva, que a folha confere.
SELECT pg_advisory_xact_lock(hashtext('0115_erp_dp_payroll_rules'));
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD COLUMN "pro_labore" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD COLUMN "family_allowance_children" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD COLUMN "alimony_percent" numeric(5, 2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD COLUMN "alimony_base" text DEFAULT 'gross_minus_inss' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_employee_remuneration" ADD CONSTRAINT "fdp_employee_remuneration_rules_check"
  CHECK ("family_allowance_children" BETWEEN 0 AND 20 AND "alimony_percent" BETWEEN 0 AND 100 AND "alimony_base" IN ('gross', 'gross_minus_inss'));
--> statement-breakpoint
ALTER TABLE "fdp_company_payroll_settings" ADD COLUMN "salary_floor_cents" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_company_payroll_settings" ADD CONSTRAINT "fdp_company_payroll_settings_floor_check" CHECK ("salary_floor_cents" >= 0);
