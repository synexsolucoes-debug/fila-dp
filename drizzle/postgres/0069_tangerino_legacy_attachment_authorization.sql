-- Demandas manuais confirmadas antes do agente de admissão não possuem um
-- cadastro de colaborador local. O identificador externo estável continua
-- obrigatório e é o único critério de seleção usado nesses casos legados.
SELECT pg_advisory_xact_lock(hashtext('0069_tangerino_legacy_attachment_authorization'));
--> statement-breakpoint

ALTER TABLE "fdp_tangerino_attachment_authorizations"
  ALTER COLUMN "employee_id" DROP NOT NULL;
