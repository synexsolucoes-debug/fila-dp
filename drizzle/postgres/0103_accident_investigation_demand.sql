-- Plano de ação do acidente, passo 1: abrir a demanda de investigação.
--
-- A análise de produto nomeou o problema com precisão: "prazo de 1 dia útil;
-- investigação solta" (§4.13 cobriu o prazo). A investigação continua sem
-- registro estruturado, e a solução não é inventar um objeto novo — cartão,
-- checklist, comentário e anexo já existem em Demandas, e é para lá que a
-- análise de desconto de EPI já manda a pergunta análoga ("preciso que
-- alguém investigue isto"). O acidente ganha o mesmo caminho.
--
-- `investigation_card_id` é a única coluna nova: nula até alguém abrir o
-- plano de ação, e depois disso aponta para o cartão que carrega a
-- investigação. Não há automação aqui — quem decide que um acidente precisa
-- de investigação é o SESMT, no momento em que apura, não uma regra que
-- adivinha gravidade.
SELECT pg_advisory_xact_lock(hashtext('0103_accident_investigation_demand'));
--> statement-breakpoint

ALTER TABLE "fdp_work_accidents" ADD COLUMN "investigation_card_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_work_accidents" ADD CONSTRAINT "fdp_work_accidents_investigation_card_fk"
  FOREIGN KEY ("workspace_id", "investigation_card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "fdp_work_accidents_workspace_investigation_idx"
  ON "fdp_work_accidents" ("workspace_id", "investigation_card_id") WHERE "investigation_card_id" IS NOT NULL;
