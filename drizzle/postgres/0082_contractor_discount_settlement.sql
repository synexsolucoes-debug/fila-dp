-- Onde o desconto do PJ é abatido quando o pagamento se divide entre nota
-- fiscal e complemento.
--
-- Até aqui o desconto sempre reduzia o líquido e a nota acompanhava o limite —
-- ou seja, quem absorvia o desconto era sempre o complemento. Um desconto
-- negociado dentro do serviço prestado precisa aparecer na nota, e não havia
-- como dizer isso: o número saía errado na conferência e alguém corrigia à mão
-- fora do sistema.
--
-- `auto` é o comportamento histórico e continua sendo o padrão, então nenhuma
-- competência já apurada muda de valor por causa desta coluna.
ALTER TABLE "fdp_contractor_components"
  ADD COLUMN IF NOT EXISTS "settlement_target" text DEFAULT 'auto' NOT NULL;
--> statement-breakpoint
-- Provento não escolhe incidência: aumentar a nota acima do limite configurado
-- é justamente o que o limite existe para impedir.
ALTER TABLE "fdp_contractor_components"
  DROP CONSTRAINT IF EXISTS "fdp_contractor_components_settlement_target_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_components"
  ADD CONSTRAINT "fdp_contractor_components_settlement_target_check"
  CHECK (
    "settlement_target" IN ('auto', 'invoice', 'complement')
    AND ("direction" = 'debit' OR "settlement_target" = 'auto')
  );
--> statement-breakpoint
-- O valor recorrente carrega a mesma escolha: ele se materializa como
-- componente da competência, e ter de repetir a incidência todo mês seria o
-- mesmo trabalho manual que o lançamento fixo existe para eliminar.
ALTER TABLE "fdp_contractor_fixed_items"
  ADD COLUMN IF NOT EXISTS "settlement_target" text DEFAULT 'auto' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_fixed_items"
  DROP CONSTRAINT IF EXISTS "fdp_contractor_fixed_items_settlement_target_check";
--> statement-breakpoint
ALTER TABLE "fdp_contractor_fixed_items"
  ADD CONSTRAINT "fdp_contractor_fixed_items_settlement_target_check"
  CHECK (
    "settlement_target" IN ('auto', 'invoice', 'complement')
    AND ("direction" = 'debit' OR "settlement_target" = 'auto')
  );
