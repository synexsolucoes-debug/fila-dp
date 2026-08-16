-- Assunto "privacidade" no formulário de contato (§50).
--
-- A página de privacidade manda o titular pedir acesso, correção, anonimização
-- ou portabilidade pela página de Contato, e o formulário não tinha assunto
-- para isso: o pedido chegava como "outro", numa tabela chamada
-- `fdp_marketing_leads`, listada no console sob "Leads comerciais".
-- Indistinguível de quem quer falar de preço, e sem nada marcando o prazo de
-- resposta que a mesma página promete.
--
-- O CHECK precisa acompanhar a lista do código. Sem esta migration, escolher o
-- assunto novo devolvia 500 ao titular — conferido contra o produto de pé antes
-- de escrever esta linha.
ALTER TABLE "fdp_marketing_leads" DROP CONSTRAINT IF EXISTS "fdp_marketing_leads_interest_check";
--> statement-breakpoint
ALTER TABLE "fdp_marketing_leads" ADD CONSTRAINT "fdp_marketing_leads_interest_check"
  CHECK ("interest" IN ('demonstracao', 'planos', 'integracoes', 'suporte', 'privacidade', 'outro'));
--> statement-breakpoint
-- A pergunta que a fila do console faz: quais pedidos de titular seguem em
-- aberto, e há quanto tempo. São poucas linhas, e o índice parcial cobre
-- exatamente elas.
CREATE INDEX IF NOT EXISTS "fdp_marketing_leads_privacy_open_idx"
  ON "fdp_marketing_leads" ("created_at")
  WHERE "interest" = 'privacidade' AND "status" IN ('new', 'contacted');
