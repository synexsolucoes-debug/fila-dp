-- O próximo passo da demanda (Operação DP).
--
-- A pergunta que a fila de DP não respondia era a mais operacional de todas:
-- "o que precisa ser feito agora?". A demanda já dizia o que é (processo), de
-- quem é (responsável), até quando (prazo) e onde está (etapa) — e nada disso
-- é a próxima ação. Quem assume a demanda de um colega lia a descrição inteira,
-- os comentários e o checklist para descobrir que faltava um comprovante.
--
-- Por que uma coluna, e não um comentário ou um item de checklist:
--
--  * comentário é histórico — ele acumula, e o último nem sempre é o próximo
--    passo; ler o fio inteiro é justamente o custo que esta coluna elimina;
--  * checklist é a lista do que falta, não a frase do que fazer agora. Um
--    checklist de nove itens não diz qual deles está bloqueando hoje;
--  * campo personalizado (`fdp_custom_fields`) seria configurável — e este
--    campo precisa existir em toda demanda, de todo grupo, sem depender de
--    alguém ter criado. O quadro o lê para ordenar atenção.
--
-- Aditiva e com default vazio: nenhuma demanda existente muda de
-- comportamento, e a ausência do texto é um estado legítimo — demanda recém
-- aberta ainda não tem próximo passo escrito, e inventar um seria pior.
ALTER TABLE "fdp_cards" ADD COLUMN IF NOT EXISTS "next_step" text DEFAULT '' NOT NULL;

-- Teto de tamanho no banco, e não só no formulário.
--
-- O campo existe para caber numa linha do cartão. Sem restrição, a primeira
-- integração que escrever uma descrição inteira aqui transforma o quadro numa
-- parede de texto — e a regra que impede isso não pode morar apenas na tela,
-- porque a tela não é o único caminho de escrita (integração, automação e
-- agente também escrevem demanda).
ALTER TABLE "fdp_cards" DROP CONSTRAINT IF EXISTS "fdp_cards_next_step_check";
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_next_step_check" CHECK (length("next_step") <= 280);
