-- Movimentos para o Sankhya (docs/movimentos-para-o-sankhya.md).
--
-- O DP lança eventos variáveis por colaborador e competência — horas extras,
-- comissões, descontos — e o Vinculato gera a planilha que o Importador de
-- Movimentos do Sankhya aceita (CODEMP, CODFUNC, REFERENCIA, TIPMOV,
-- CODEVENTO, SEQUENCIA, INDICE, VLRMOV, TIPEVENTO, UNIDADE).
--
-- Duas tabelas:
--   * o catálogo de eventos (TFPEVE) do workspace, importado da query do
--     Sankhya. O Vinculato não inventa evento: o código, a unidade e o tipo
--     vêm de lá, e a planilha leva exatamente o que o catálogo diz;
--   * os lançamentos. Valor em centavos; índice (horas, dias, quantidade) em
--     numeric. Exportar marca quando e por quem — não apaga nem congela: a
--     folha continua sendo do Sankhya.
SELECT pg_advisory_xact_lock(hashtext('0113_payroll_movements'));
--> statement-breakpoint

CREATE TABLE "fdp_payroll_event_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	-- CODEVENTO do Sankhya.
	"code" integer NOT NULL,
	"description" text NOT NULL,
	-- V valor, H horas, D dias, Q quantidade ou percentual.
	"unit" text NOT NULL,
	-- 1 provento, -1 desconto, 0 informativo.
	"event_type" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"imported_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_payroll_event_catalog_code_check" CHECK ("code" > 0),
	CONSTRAINT "fdp_payroll_event_catalog_unit_check" CHECK ("unit" IN ('V', 'H', 'D', 'Q')),
	CONSTRAINT "fdp_payroll_event_catalog_type_check" CHECK ("event_type" IN (-1, 0, 1)),
	CONSTRAINT "fdp_payroll_event_catalog_status_check" CHECK ("status" IN ('active', 'inactive')),
	CONSTRAINT "fdp_payroll_event_catalog_description_check" CHECK (length("description") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_event_catalog_workspace_id_uq" ON "fdp_payroll_event_catalog" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_event_catalog_code_uq" ON "fdp_payroll_event_catalog" USING btree ("workspace_id", "code");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_event_catalog" ADD CONSTRAINT "fdp_payroll_event_catalog_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_event_catalog" ADD CONSTRAINT "fdp_payroll_event_catalog_importer_fk"
  FOREIGN KEY ("workspace_id", "imported_by") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_event_catalog" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_event_catalog" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_payroll_event_catalog_workspace_isolation" ON "fdp_payroll_event_catalog"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

CREATE TABLE "fdp_payroll_movement_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"competence" text NOT NULL,
	"event_code" integer NOT NULL,
	-- Horas, dias ou quantidade. Evento de valor leva zero aqui.
	"index_value" numeric(14, 4) DEFAULT 0 NOT NULL,
	"amount_cents" bigint DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"exported_at" timestamp with time zone,
	"exported_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_payroll_movement_entries_competence_check" CHECK ("competence" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "fdp_payroll_movement_entries_event_check" CHECK ("event_code" > 0),
	CONSTRAINT "fdp_payroll_movement_entries_values_check" CHECK ("index_value" >= 0 AND "amount_cents" >= 0 AND ("index_value" > 0 OR "amount_cents" > 0)),
	CONSTRAINT "fdp_payroll_movement_entries_exported_check" CHECK (("exported_at" IS NULL) = ("exported_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_payroll_movement_entries_workspace_id_uq" ON "fdp_payroll_movement_entries" USING btree ("workspace_id", "id");
--> statement-breakpoint
CREATE INDEX "fdp_payroll_movement_entries_company_competence_idx" ON "fdp_payroll_movement_entries" USING btree ("workspace_id", "company_id", "competence");
--> statement-breakpoint
CREATE INDEX "fdp_payroll_movement_entries_employee_idx" ON "fdp_payroll_movement_entries" USING btree ("workspace_id", "employee_id", "competence");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_movement_entries" ADD CONSTRAINT "fdp_payroll_movement_entries_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_movement_entries" ADD CONSTRAINT "fdp_payroll_movement_entries_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_movement_entries" ADD CONSTRAINT "fdp_payroll_movement_entries_employee_fk"
  FOREIGN KEY ("workspace_id", "company_id", "employee_id") REFERENCES "public"."fdp_employees"("workspace_id", "company_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_movement_entries" ADD CONSTRAINT "fdp_payroll_movement_entries_author_fk"
  FOREIGN KEY ("workspace_id", "created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_movement_entries" ADD CONSTRAINT "fdp_payroll_movement_entries_exporter_fk"
  FOREIGN KEY ("workspace_id", "exported_by") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id");
--> statement-breakpoint
ALTER TABLE "fdp_payroll_movement_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_payroll_movement_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_payroll_movement_entries_workspace_isolation" ON "fdp_payroll_movement_entries"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
