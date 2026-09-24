-- Obrigação legal ganha unidade opcional (fdp_establishments,
-- 0095_registrations_establishments_catalog.sql), no mesmo padrão de
-- fdp_employees.establishment_id (0096_employee_establishment.sql): coluna
-- nula, sem migrar nenhuma obrigação existente. Cliente com mais de um
-- endereço físico sob o mesmo CNPJ ganha, com isto, onde localizar qual
-- unidade uma obrigação pertence — o Motor de Prazos e a Central de Trabalho
-- continuam lendo a mesma tabela, só com mais um dado disponível quando
-- alguém preencher.
SELECT pg_advisory_xact_lock(hashtext('0097_obligation_establishment'));
--> statement-breakpoint

ALTER TABLE "fdp_compliance_obligations" ADD COLUMN IF NOT EXISTS "establishment_id" text;
--> statement-breakpoint

ALTER TABLE "fdp_compliance_obligations" ADD CONSTRAINT "fdp_compliance_obligations_workspace_establishment_fk"
  FOREIGN KEY ("workspace_id", "company_id", "establishment_id") REFERENCES "public"."fdp_establishments"("workspace_id", "company_id", "id");
