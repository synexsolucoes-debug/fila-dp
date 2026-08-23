-- O Agente Tangerino ganha a linha sem a qual ele nunca existiu.
--
-- A auditoria desta entrega encontrou um defeito que estava de pé desde a
-- migration 0056: `lib/tangerino/queue.ts` procura a integração do agente por
-- `channel = 'tangerino_browser'`, e o provisionamento de workspace nunca criou
-- essa linha. Ele semeia nove canais — e-mail, WhatsApp, Teams, Drive, OneDrive,
-- Sólides, Tangerino (API), Sankhya e ERP — e o do navegador não está entre eles.
--
-- O efeito é o pior tipo de beco: a consulta de admissão recusa com "O agente
-- Tangerino não está configurado neste grupo", mandando configurar em
-- Integrações, onde o conector não aparece porque não existe. Não havia caminho
-- nenhum, em nenhuma tela, que criasse essa linha. O agente de navegador do
-- Tangerino — Playwright real, somente leitura, cofre próprio, UI_CHANGED — está
-- escrito, testado e **inalcançável em todos os workspaces**.
--
-- Esta migration é de provisionamento, não de renomeação. Ela não toca em canal
-- existente, não renomeia chave e não apaga nada: apenas cria a linha que
-- faltava, para os grupos que já existem, com o mesmo identificador determinístico
-- que o provisionamento usa. O `ON CONFLICT DO NOTHING` a torna repetível.
--
-- O canal nasce em `needs_credentials` de propósito: existir não é estar
-- configurado, e o estado precisa dizer a verdade desde o primeiro instante.
SELECT pg_advisory_xact_lock(hashtext('0066_tangerino_agent_provisioning'));
--> statement-breakpoint

INSERT INTO "fdp_integrations" ("id", "workspace_id", "channel", "display_name", "status")
SELECT w."id" || ':integration:tangerino_browser', w."id", 'tangerino_browser', 'Agente Tangerino', 'needs_credentials'
  FROM "fdp_workspaces" w
 WHERE NOT EXISTS (
   SELECT 1 FROM "fdp_integrations" i
    WHERE i."workspace_id" = w."id" AND i."channel" = 'tangerino_browser'
 )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- O nome exibido dos três agentes passa a ser o nome de produto.
--
-- A tela lê o rótulo do catálogo e não desta coluna, justamente para que um
-- nome técnico gravado um dia não vaze. Mas a coluna também aparece em
-- exportação, em auditoria antiga e no console da plataforma, e deixar
-- "Sankhya Browser Connector" gravado manteria o vocabulário técnico vivo em
-- todos esses lugares. Só o rótulo muda; canal, histórico e configuração ficam
-- exatamente onde estão.
UPDATE "fdp_integrations" SET "display_name" = 'Agente Sankhya', "updated_at" = now()
 WHERE "channel" = 'sankhya_browser' AND "display_name" <> 'Agente Sankhya';
--> statement-breakpoint

UPDATE "fdp_integrations" SET "display_name" = 'Agente Teams', "updated_at" = now()
 WHERE "channel" = 'teams' AND "display_name" <> 'Agente Teams';
