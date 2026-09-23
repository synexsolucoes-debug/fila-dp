-- Sindicatos como cadastro auxiliar, no mesmo desenho de departamentos,
-- cargos, centros de custo e jornadas (0013_registrations_foundation.sql).
--
-- Por que agora: a ficha de admissão da Sólides não usa sindicato, mas a
-- planilha que o Sankhya espera para dar entrada na admissão tem CODSIND
-- como campo obrigatório, e não existia onde guardar esse código dentro do
-- Vinculato. Sem esta tabela, o único jeito de gerar a planilha certa seria
-- perguntar o sindicato pessoa por pessoa — com o cadastro auxiliar, quem
-- confere escolhe de uma lista, igual já faz para cargo e departamento.
SELECT pg_advisory_xact_lock(hashtext('0094_registrations_unions_catalog'));
--> statement-breakpoint

CREATE TABLE "fdp_unions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_unions_status_check" CHECK ("status" IN ('active', 'inactive'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX "fdp_unions_workspace_company_code_uq" ON "fdp_unions" USING btree ("workspace_id", "company_id", "code");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_unions_workspace_company_id_uq" ON "fdp_unions" USING btree ("workspace_id", "company_id", "id");
--> statement-breakpoint

ALTER TABLE "fdp_unions" ADD CONSTRAINT "fdp_unions_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_unions" ADD CONSTRAINT "fdp_unions_workspace_company_fk"
  FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fdp_unions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_unions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_unions_workspace_isolation" ON "fdp_unions"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
