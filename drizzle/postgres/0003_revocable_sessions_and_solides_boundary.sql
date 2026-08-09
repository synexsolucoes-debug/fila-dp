CREATE TABLE "fdp_auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fdp_auth_sessions" ADD CONSTRAINT "fdp_auth_sessions_user_id_fdp_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."fdp_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_auth_sessions_token_hash_uq" ON "fdp_auth_sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "fdp_auth_sessions_user_expiry_idx" ON "fdp_auth_sessions" USING btree ("user_id","expires_at");
--> statement-breakpoint
CREATE INDEX "fdp_auth_sessions_active_idx" ON "fdp_auth_sessions" USING btree ("expires_at","revoked_at");
--> statement-breakpoint
UPDATE "fdp_process_templates" template
SET "name" = 'Conciliação de colaborador admitido',
    "process_type" = 'CONCILIAÇÃO CADASTRAL',
    "description" = 'Importação, vinculação e conciliação de dados concluídos na Sólides com o ERP.',
    "checklist_json" = '["Importação concluída","Registro da Sólides vinculado ao ERP","Divergências cadastrais tratadas","Sincronização registrada"]'
WHERE template."id" = template."workspace_id" || ':template:admissao'
  AND template."name" = 'Admissão completa'
  AND NOT EXISTS (
    SELECT 1 FROM "fdp_process_templates" existing
    WHERE existing."workspace_id" = template."workspace_id"
      AND existing."name" = 'Conciliação de colaborador admitido'
      AND existing."id" <> template."id"
  );
--> statement-breakpoint
UPDATE "fdp_process_templates"
SET "active" = 0
WHERE "id" = "workspace_id" || ':template:admissao'
  AND "process_type" = 'ADMISSÃO';
--> statement-breakpoint
UPDATE "fdp_sla_policies"
SET "active" = 0
WHERE "process_type" = 'ADMISSÃO';
--> statement-breakpoint
INSERT INTO "fdp_sla_policies" ("id", "workspace_id", "process_type", "target_business_days", "warning_business_days", "active")
SELECT workspace."id" || ':sla:CONCILIAÇÃO CADASTRAL', workspace."id", 'CONCILIAÇÃO CADASTRAL', 2, 1, 1
FROM "fdp_workspaces" workspace
ON CONFLICT ("workspace_id", "process_type") DO NOTHING;
--> statement-breakpoint
INSERT INTO "fdp_integrations" ("id", "workspace_id", "channel", "display_name", "status", "config_json")
SELECT workspace."id" || ':integration:solides', workspace."id", 'solides', 'Sólides', 'needs_credentials', '{}'
FROM "fdp_workspaces" workspace
ON CONFLICT ("workspace_id", "channel") DO NOTHING;
