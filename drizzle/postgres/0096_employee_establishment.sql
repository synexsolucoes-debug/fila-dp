-- Colaborador ganha unidade opcional (fdp_establishments,
-- 0095_registrations_establishments_catalog.sql), no mesmo padrão de
-- cost_center_id/work_schedule_id: uma coluna nula, sem migração de dados,
-- porque nenhum colaborador existente tem unidade — quem cadastrar ou editar
-- escolhe, e quem não escolher continua sem, exatamente como já acontecia
-- antes de o cadastro de unidade existir.
SELECT pg_advisory_xact_lock(hashtext('0096_employee_establishment'));
--> statement-breakpoint

ALTER TABLE "fdp_employees" ADD COLUMN IF NOT EXISTS "establishment_id" text;
--> statement-breakpoint

ALTER TABLE "fdp_employees" ADD CONSTRAINT "fdp_employees_workspace_establishment_fk"
  FOREIGN KEY ("workspace_id", "company_id", "establishment_id") REFERENCES "public"."fdp_establishments"("workspace_id", "company_id", "id");
