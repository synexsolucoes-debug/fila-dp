-- Autorização automática de anexos para admissão descoberta sem colaborador.
--
-- O DP pediu para não precisar clicar em "Autorizar anexos da Sólides" toda
-- vez: quando a descoberta cria a demanda, ela mesma já autoriza a busca dos
-- documentos e da ficha. Não há uma pessoa clicando nesse instante — a coluna
-- era NOT NULL porque, até aqui, toda autorização partia de um clique.
SELECT pg_advisory_xact_lock(hashtext('0092_tangerino_attachment_auto_authorize'));
--> statement-breakpoint

ALTER TABLE "fdp_tangerino_attachment_authorizations" ALTER COLUMN "authorized_by_user_id" DROP NOT NULL;
