-- Cancelar uma demanda é diferente de concluí-la (spec: Ações da demanda).
--
-- Hoje só existem dois desfechos: `closed_at` preenchido (saiu da operação) e
-- `archived` (sumiu da vista). Uma admissão que não vai acontecer — candidato
-- desistiu, vaga cancelada, duplicidade — só podia ser "concluída" ou
-- arquivada. As duas mentem: a primeira conta como trabalho entregue nos
-- indicadores, a segunda apaga o registro da vista sem dizer por quê.
--
-- ## Por que duas colunas, e não um status novo
--
-- `cancelled_at` acompanha `closed_at` em vez de substituí-lo. Cancelar preenche
-- **as duas**: a demanda sai da fila (é o que `closed_at` significa) e fica
-- marcada como não-entregue.
--
-- Isso mantém corretas, sem tocar em nenhuma, as sete consultas que perguntam
-- "o que está aberto" com `closed_at IS NULL` — demanda cancelada não está
-- aberta. Só as três que contam entrega com `closed_at IS NOT NULL` precisam
-- excluir cancelada, e elas são poucas e conhecidas.
--
-- O caminho oposto — um `status` novo — obrigaria a revisar as dez, e a décima
-- primeira, escrita depois, nasceria contando cancelada como aberta ou como
-- entregue, conforme o descuido.
--
-- ## Por que o motivo é obrigatório
--
-- Cancelamento sem motivo é a informação que falta exatamente quando alguém
-- pergunta, meses depois, por que aquela admissão não aconteceu. A restrição
-- abaixo recusa `cancelled_at` sem texto: ou a demanda não está cancelada, ou
-- se sabe por quê.

SELECT pg_advisory_xact_lock(hashtext('0071_card_cancellation'));
--> statement-breakpoint

ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "cancellation_reason" text NOT NULL DEFAULT '';
--> statement-breakpoint

-- Cancelada sem motivo, ou motivo sem cancelamento, é estado que mente para
-- quem lê depois. Ou existem os dois, ou não existe nenhum.
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_cancellation_check";
--> statement-breakpoint
ALTER TABLE "fdp_cards"
  ADD CONSTRAINT "fdp_cards_cancellation_check"
  CHECK (
    ("cancelled_at" IS NULL AND "cancellation_reason" = '')
    OR ("cancelled_at" IS NOT NULL AND length(btrim("cancellation_reason")) > 0)
  );
--> statement-breakpoint

-- Demanda cancelada saiu da operação: `closed_at` é o que todas as consultas de
-- "em aberto" já leem. Cancelar sem fechar deixaria a demanda para sempre na
-- fila de alguém.
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_cancelled_is_closed_check";
--> statement-breakpoint
ALTER TABLE "fdp_cards"
  ADD CONSTRAINT "fdp_cards_cancelled_is_closed_check"
  CHECK ("cancelled_at" IS NULL OR "closed_at" IS NOT NULL);
--> statement-breakpoint

-- As consultas de produtividade filtram por aqui; sem índice elas varrem a
-- tabela inteira para descontar o que é raro.
CREATE INDEX IF NOT EXISTS "fdp_cards_workspace_cancelled_idx"
  ON "fdp_cards" ("workspace_id", "cancelled_at")
  WHERE "cancelled_at" IS NOT NULL;
