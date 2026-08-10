-- Modelos oficiais de importação da Caju.
--
-- A exportação de Saldo Livre precisa seguir o arquivo baixado do portal da
-- Caju: cabeçalhos, abas e validações mudam sem aviso, e um XLSX "parecido"
-- seria recusado na importação. Por isso o produto não traz modelo embutido —
-- ele guarda o arquivo oficial que o administrador subir, versionado.
--
-- Um modelo ativo por vez, por workspace. As versões anteriores ficam para
-- auditoria: saber com qual layout uma exportação passada foi gerada.
CREATE TABLE IF NOT EXISTS "fdp_caju_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"version" integer NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"checksum" text NOT NULL,
	-- Mapeamento entre os campos internos e as colunas oficiais do arquivo.
	"column_map_json" text DEFAULT '{}' NOT NULL,
	"sheet_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "fdp_caju_templates_status_check" CHECK ("status" IN ('draft', 'active', 'retired')),
	CONSTRAINT "fdp_caju_templates_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 5242880)
);
--> statement-breakpoint
ALTER TABLE "fdp_caju_templates" ADD CONSTRAINT "fdp_caju_templates_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_caju_templates_version_uq" ON "fdp_caju_templates" ("workspace_id", "version");
--> statement-breakpoint
-- Só um modelo ativo por workspace: a exportação não pode escolher entre dois.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_caju_templates_active_uq" ON "fdp_caju_templates" ("workspace_id")
  WHERE "status" = 'active';
--> statement-breakpoint
ALTER TABLE "fdp_caju_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_caju_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_caju_templates_read" ON "fdp_caju_templates" FOR SELECT
  USING ("workspace_id" = current_setting('app.workspace_id', true));
--> statement-breakpoint
CREATE POLICY "fdp_caju_templates_write" ON "fdp_caju_templates" FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
