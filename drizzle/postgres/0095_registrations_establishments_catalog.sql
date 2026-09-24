-- Unidade (estabelecimento) como cadastro auxiliar, no mesmo desenho de
-- departamentos, cargos, centros de custo, jornadas e sindicatos
-- (0013_registrations_foundation.sql, 0094_registrations_unions_catalog.sql).
--
-- Por que agora: a análise de produto de set/2026 (docs/evolucao-produto-2026-09)
-- nomeou a falta de uma unidade/estabelecimento distinta da empresa como uma
-- lacuna do cadastro — cliente com mais de um endereço físico sob o mesmo CNPJ
-- (matriz e obra, loja e depósito) não tem hoje onde registrar isso além do
-- próprio nome da empresa. Este passo só cria o cadastro auxiliar, no mesmo
-- desenho simples de código/nome/status que os demais; vincular colaborador,
-- obrigação legal ou requisito de EPI à unidade é trabalho futuro (a coluna
-- em cada uma dessas tabelas ainda não existe).
SELECT pg_advisory_xact_lock(hashtext('0095_registrations_establishments_catalog'));
--> statement-breakpoint

CREATE TABLE "fdp_establishments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_establishments_status_check" CHECK ("status" IN ('active', 'inactive'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX "fdp_establishments_workspace_company_code_uq" ON "fdp_establishments" USING btree ("workspace_id", "company_id", "code");
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_establishments_workspace_company_id_uq" ON "fdp_establishments" USING btree ("workspace_id", "company_id", "id");
--> statement-breakpoint

ALTER TABLE "fdp_establishments" ADD CONSTRAINT "fdp_establishments_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fdp_establishments" ADD CONSTRAINT "fdp_establishments_workspace_company_fk"
  FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fdp_establishments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_establishments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_establishments_workspace_isolation" ON "fdp_establishments"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
