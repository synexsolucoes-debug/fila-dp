-- ERP DP: obrigações e pagamento da folha (item 13 do roadmap, §4.40 de
-- docs/arquitetura-operacional.md).
--
-- 1. Configuração de folha da empresa: forma da contribuição patronal, RAT,
--    FAP e terceiros, a conta bancária de onde sai o pagamento (convênio do
--    CNAB) e as contas contábeis dos lançamentos.
-- 2. Dados bancários do colaborador (o infotipo 0009 do SAP): para onde vai o
--    salário no arquivo CNAB.
SELECT pg_advisory_xact_lock(hashtext('0117_erp_dp_obligations'));
--> statement-breakpoint

CREATE TABLE "fdp_company_payroll_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employer_contribution" text DEFAULT 'standard' NOT NULL,
	"rat_percent" numeric(4, 2) DEFAULT 2 NOT NULL,
	"fap" numeric(5, 4) DEFAULT 1 NOT NULL,
	"third_parties_percent" numeric(5, 2) DEFAULT 5.8 NOT NULL,
	"bank_code" text DEFAULT '' NOT NULL,
	"bank_agency" text DEFAULT '' NOT NULL,
	"bank_agency_digit" text DEFAULT '' NOT NULL,
	"bank_account" text DEFAULT '' NOT NULL,
	"bank_account_digit" text DEFAULT '' NOT NULL,
	"bank_agreement" text DEFAULT '' NOT NULL,
	"accounts_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_company_payroll_settings_contribution_check" CHECK ("employer_contribution" IN ('standard', 'simples_exempt')),
	CONSTRAINT "fdp_company_payroll_settings_rat_check" CHECK ("rat_percent" IN (1, 2, 3)),
	CONSTRAINT "fdp_company_payroll_settings_fap_check" CHECK ("fap" BETWEEN 0.5 AND 2),
	CONSTRAINT "fdp_company_payroll_settings_third_check" CHECK ("third_parties_percent" BETWEEN 0 AND 10),
	CONSTRAINT "fdp_company_payroll_settings_accounts_check" CHECK (jsonb_typeof("accounts_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_company_payroll_settings_workspace_id_uq" ON "fdp_company_payroll_settings" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_company_payroll_settings_company_uq" ON "fdp_company_payroll_settings" USING btree ("workspace_id", "company_id");
--> statement-breakpoint
ALTER TABLE "fdp_company_payroll_settings" ADD CONSTRAINT "fdp_company_payroll_settings_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_company_payroll_settings" ADD CONSTRAINT "fdp_company_payroll_settings_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_company_payroll_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_company_payroll_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_company_payroll_settings_workspace_isolation" ON "fdp_company_payroll_settings"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

CREATE TABLE "fdp_employee_bank_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"employee_id" text NOT NULL,
	"bank_code" text NOT NULL,
	"agency" text NOT NULL,
	"agency_digit" text DEFAULT '' NOT NULL,
	"account" text NOT NULL,
	"account_digit" text DEFAULT '' NOT NULL,
	"account_type" text DEFAULT 'checking' NOT NULL,
	"pix_key" text DEFAULT '' NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_employee_bank_accounts_type_check" CHECK ("account_type" IN ('checking', 'savings', 'salary')),
	CONSTRAINT "fdp_employee_bank_accounts_bank_check" CHECK ("bank_code" ~ '^[0-9]{3}$'),
	CONSTRAINT "fdp_employee_bank_accounts_numbers_check" CHECK ("agency" ~ '^[0-9]{1,5}$' AND "account" ~ '^[0-9]{1,12}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_employee_bank_accounts_workspace_id_uq" ON "fdp_employee_bank_accounts" USING btree ("workspace_id", "id");
--> statement-breakpoint
-- Uma conta de salário por colaborador: a vigente.
CREATE UNIQUE INDEX "fdp_employee_bank_accounts_employee_uq" ON "fdp_employee_bank_accounts" USING btree ("workspace_id", "employee_id");
--> statement-breakpoint
ALTER TABLE "fdp_employee_bank_accounts" ADD CONSTRAINT "fdp_employee_bank_accounts_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_bank_accounts" ADD CONSTRAINT "fdp_employee_bank_accounts_employee_fk"
  FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_employee_bank_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_employee_bank_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_employee_bank_accounts_workspace_isolation" ON "fdp_employee_bank_accounts"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
