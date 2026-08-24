-- Matriz de obrigatoriedade e ciclo de troca de EPI.
--
-- O estoque e as entregas já respondem "o que existe" e "quem recebeu".
-- Esta tabela adiciona o terceiro fato necessário para conformidade: o que
-- cada lotação deveria possuir. A regra pertence à empresa consumidora porque
-- cargos e departamentos são cadastros por CNPJ; o produto e o saldo continuam
-- pertencendo ao Workspace/grupo.
CREATE TABLE "fdp_epi_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
	"company_id" text NOT NULL,
	"department_id" text,
	"position_id" text,
	"product_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"replacement_days" integer DEFAULT 0 NOT NULL,
	"warning_days" integer DEFAULT 30 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fdp_epi_requirements_quantity_check" CHECK ("quantity" BETWEEN 1 AND 100),
	CONSTRAINT "fdp_epi_requirements_replacement_check" CHECK ("replacement_days" BETWEEN 0 AND 3650),
	CONSTRAINT "fdp_epi_requirements_warning_check" CHECK ("warning_days" BETWEEN 0 AND 365),
	CONSTRAINT "fdp_epi_requirements_active_check" CHECK ("active" IN (0, 1))
);--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_requirements_workspace_id_uq" ON "fdp_epi_requirements" ("workspace_id", "id");--> statement-breakpoint
-- NULL significa "qualquer departamento/cargo". COALESCE impede duas regras
-- idênticas de serem inseridas apenas porque uma das dimensões é global.
CREATE UNIQUE INDEX "fdp_epi_requirements_scope_product_uq" ON "fdp_epi_requirements"
  ("workspace_id", "company_id", COALESCE("department_id", ''), COALESCE("position_id", ''), "product_id");--> statement-breakpoint
CREATE INDEX "fdp_epi_requirements_workspace_company_active_idx" ON "fdp_epi_requirements"
  ("workspace_id", "company_id", "active");--> statement-breakpoint
CREATE INDEX "fdp_epi_requirements_workspace_product_idx" ON "fdp_epi_requirements"
  ("workspace_id", "product_id");--> statement-breakpoint
ALTER TABLE "fdp_epi_requirements" ADD CONSTRAINT "fdp_epi_requirements_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "fdp_epi_requirements" ADD CONSTRAINT "fdp_epi_requirements_company_fk"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "fdp_epi_requirements" ADD CONSTRAINT "fdp_epi_requirements_department_fk"
  FOREIGN KEY ("workspace_id", "company_id", "department_id") REFERENCES "public"."fdp_departments"("workspace_id", "company_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_requirements" ADD CONSTRAINT "fdp_epi_requirements_position_fk"
  FOREIGN KEY ("workspace_id", "company_id", "position_id") REFERENCES "public"."fdp_positions"("workspace_id", "company_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_requirements" ADD CONSTRAINT "fdp_epi_requirements_product_fk"
  FOREIGN KEY ("workspace_id", "product_id") REFERENCES "public"."fdp_epi_products"("workspace_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_epi_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_epi_requirements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_epi_requirements_workspace_isolation" ON "fdp_epi_requirements"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));--> statement-breakpoint
