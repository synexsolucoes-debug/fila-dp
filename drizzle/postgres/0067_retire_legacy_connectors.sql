-- Os conectores anteriores param de executar sozinhos.
--
-- A decisão de produto tirou Tangerino API, Sólides, e-mail, WhatsApp, Drive,
-- OneDrive e ERP da experiência operacional. Esconder a tela, porém, não para a
-- automação: o Tangerino API estava agendado a cada 30 minutos e continuaria
-- lendo dado de cliente sem cartão na tela, sem estado e sem botão de pausa ao
-- alcance de quem opera. Automação invisível é automação fora das regras — pior
-- que automação nenhuma, porque ninguém sabe que precisa olhar.
--
-- Então a execução automática deles é desligada aqui, por decisão explícita.
--
-- O QUE ESTA MIGRATION NÃO FAZ
--
-- Não apaga integração, não apaga credencial, não apaga execução, evento,
-- proposta, job nem auditoria. Nada de histórico é tocado. Os conectores
-- continuam existindo, continuam com tudo o que produziram e continuam
-- administráveis pelo console da plataforma, onde um administrador pode
-- reativá-los a qualquer momento — o caminho de volta continua aberto, e é isso
-- que separa "aposentar" de "destruir".
--
-- `schedule_enabled = 0` é o desligamento; `status = 'paused'` é o que a tela e
-- o webhook já respeitam. Os dois juntos porque respondem a coisas diferentes:
-- um impede a varredura de agendar, o outro impede qualquer execução de ser
-- aceita, inclusive a manual.
SELECT pg_advisory_xact_lock(hashtext('0067_retire_legacy_connectors'));
--> statement-breakpoint

UPDATE "fdp_integrations"
   SET "schedule_enabled" = 0,
       "next_sync_at" = NULL,
       "status" = CASE WHEN "status" = 'paused' THEN "status" ELSE 'paused' END,
       "updated_at" = now()
 WHERE "channel" IN ('tangerino', 'solides', 'email', 'whatsapp', 'drive', 'onedrive', 'erp')
   AND ("schedule_enabled" = 1 OR "status" <> 'paused');
