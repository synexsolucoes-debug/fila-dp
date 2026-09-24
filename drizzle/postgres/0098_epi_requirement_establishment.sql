-- Regra de EPI obrigatório ganha unidade como terceira dimensão de escopo,
-- ao lado de departamento e cargo (0048_epi_compliance.sql). Obra e
-- escritório da mesma empresa exigem EPIs diferentes para o mesmo cargo; até
-- aqui a única saída era criar cargos duplicados por endereço.
--
-- NULL continua significando "qualquer unidade", exatamente como já
-- significava para departamento e cargo: toda regra existente segue valendo
-- para todo colaborador que ela já cobria.
SELECT pg_advisory_xact_lock(hashtext('0098_epi_requirement_establishment'));
--> statement-breakpoint

ALTER TABLE "fdp_epi_requirements" ADD COLUMN IF NOT EXISTS "establishment_id" text;
--> statement-breakpoint

ALTER TABLE "fdp_epi_requirements" ADD CONSTRAINT "fdp_epi_requirements_establishment_fk"
  FOREIGN KEY ("workspace_id", "company_id", "establishment_id") REFERENCES "public"."fdp_establishments"("workspace_id", "company_id", "id") ON DELETE restrict;
--> statement-breakpoint

-- A unicidade passa a considerar a unidade: sem isto, "capacete para a Obra"
-- e "capacete para o Escritório" colidiriam, porque os dois têm departamento
-- e cargo em branco. O índice novo é estritamente menos restritivo que o
-- anterior — toda linha existente tem unidade nula, então nenhuma chave que
-- já era única deixa de ser.
DROP INDEX IF EXISTS "fdp_epi_requirements_scope_product_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_epi_requirements_scope_product_uq" ON "fdp_epi_requirements"
  ("workspace_id", "company_id", COALESCE("department_id", ''), COALESCE("position_id", ''), COALESCE("establishment_id", ''), "product_id");
