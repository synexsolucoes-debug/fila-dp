ALTER TABLE "fdp_integration_mappings" DROP CONSTRAINT IF EXISTS "fdp_integration_mappings_resource_check";
--> statement-breakpoint
ALTER TABLE "fdp_integration_mappings" ADD CONSTRAINT "fdp_integration_mappings_resource_check"
	CHECK ("resource_type" IN ('inbox', 'employees', 'hr_metrics', 'files', 'admissions'));
--> statement-breakpoint
UPDATE "fdp_integrations"
SET "display_name" = 'Sólides',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "channel" = 'solides' AND "display_name" = '';
--> statement-breakpoint
INSERT INTO "fdp_process_templates" ("id", "workspace_id", "name", "process_type", "description", "checklist_json", "default_sla_days", "position")
SELECT workspace."id" || ':template:conciliacao-solides', workspace."id", 'Conciliação de colaborador admitido', 'CONCILIAÇÃO CADASTRAL',
	'Conciliação dos dados de quem já foi admitido na Sólides: ficha, documentos e vínculo com o ERP.',
	'["Conferir a ficha recebida da Sólides","Baixar os arquivos dos documentos na Sólides e anexar à tarefa","Vincular o registro da Sólides ao ERP","Tratar divergências cadastrais","Registrar a sincronização concluída"]',
	2, 1500
FROM "fdp_workspaces" workspace
WHERE NOT EXISTS (
	SELECT 1 FROM "fdp_process_templates" existing
	WHERE existing."workspace_id" = workspace."id" AND existing."process_type" = 'CONCILIAÇÃO CADASTRAL' AND existing."active" = 1
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "fdp_sla_policies" ("id", "workspace_id", "process_type", "target_business_days", "warning_business_days", "active")
SELECT workspace."id" || ':sla:CONCILIAÇÃO CADASTRAL', workspace."id", 'CONCILIAÇÃO CADASTRAL', 2, 1, 1
FROM "fdp_workspaces" workspace
ON CONFLICT ("workspace_id", "process_type") DO NOTHING;
