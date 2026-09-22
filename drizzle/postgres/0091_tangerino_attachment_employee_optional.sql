-- Autorização de anexos passa a aceitar admissão sem colaborador vinculado.
--
-- A descoberta (0090) cria demanda para quem ainda não é colaborador — o
-- cartão nasce com employee_id nulo de propósito, e é exatamente essa pessoa
-- que precisa da autorização de anexos para trazer a ficha e os documentos.
-- A coluna era NOT NULL porque, até aqui, toda autorização partia de alguém
-- já cadastrado. A chave estrangeira composta não precisa de ajuste: com
-- employee_id nulo, o Postgres não valida a referência (MATCH SIMPLE).
SELECT pg_advisory_xact_lock(hashtext('0091_tangerino_attachment_employee_optional'));
--> statement-breakpoint

ALTER TABLE "fdp_tangerino_attachment_authorizations" ALTER COLUMN "employee_id" DROP NOT NULL;
