-- Vocabulário morto no catálogo de EPI (§52) e ativação da tabela de uso (§50).
--
-- ## EPI: estado de unidade em tabela de catálogo
--
-- `fdp_epi_products` é o **catálogo** — o modelo de equipamento, não a peça
-- física. O CHECK dele, porém, admitia sete estados que só fazem sentido para
-- uma unidade: `in_stock`, `delivered`, `returned`, `sanitizing`, `discarded`,
-- `damaged` e `lost`. A aplicação nunca escreveu nenhum deles ali: o catálogo só
-- recebe `active` e `inactive`, e os estados de unidade vão para
-- `fdp_epi_movements.status`, onde pertencem.
--
-- Um vocabulário que o banco aceita e ninguém usa não é inofensivo: ele é um
-- convite documentado ao erro. Quem for escrever a próxima rota vai encontrar
-- `delivered` na lista de estados válidos do produto e concluir que o catálogo
-- guarda a posse — e a partir daí o estoque passa a mentir.
--
-- O preflight recusa em vez de corrigir: se existir linha fora do vocabulário
-- novo, a migration falha dizendo quantas são. Converter dado de cliente por
-- palpite é pior do que parar o deploy.
--
-- ## Contadores de uso: ativar em vez de apagar
--
-- `fdp_workspace_usage_counters` estava viva no schema e morta no código —
-- nenhuma leitura, nenhuma escrita. O §50 dá duas saídas, e a escolha aqui é a
-- primeira: **ativá-la com função real**. Ela já tem a forma exata do que a
-- telemetria de adoção (§77) precisa — workspace, métrica, período, quantidade —
-- e criar uma segunda tabela ao lado dela seria repetir o erro que este trabalho
-- inteiro está corrigindo.
--
-- O vocabulário de métricas cresce para incluir a adoção. As quatro anteriores
-- continuam válidas: elas são a quota do plano, e ninguém as removeu.
SELECT pg_advisory_xact_lock(hashtext('0062_epi_catalog_status_and_adoption_metrics'));
--> statement-breakpoint

DO $$
DECLARE fora integer;
BEGIN
  SELECT count(*) INTO fora FROM "fdp_epi_products" WHERE "status" NOT IN ('active', 'inactive');
  IF fora > 0 THEN
    RAISE EXCEPTION
      'Existem % produtos de EPI com estado de unidade no catálogo. Normalize-os para active/inactive antes de aplicar esta migration.', fora;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "fdp_epi_products" DROP CONSTRAINT IF EXISTS "fdp_epi_products_status_check";
--> statement-breakpoint
ALTER TABLE "fdp_epi_products"
  ADD CONSTRAINT "fdp_epi_products_status_check" CHECK ("status" IN ('active', 'inactive'));
--> statement-breakpoint

ALTER TABLE "fdp_workspace_usage_counters" DROP CONSTRAINT IF EXISTS "fdp_workspace_usage_metric_check";
--> statement-breakpoint
ALTER TABLE "fdp_workspace_usage_counters"
  ADD CONSTRAINT "fdp_workspace_usage_metric_check" CHECK ("metric" IN (
    -- Quota do plano, que já existia.
    'members', 'companies', 'integrations', 'storage_mb',
    -- Adoção da consolidação (§77). Nenhuma delas identifica pessoa: são
    -- contagens por grupo e por competência.
    'demands_from_process', 'process_steps_advanced', 'process_instances_completed',
    'events_received', 'events_deduplicated', 'triage_opened',
    'agent_actions_automatic', 'agent_actions_refused',
    'work_center_opened', 'assistant_queries', 'deep_links_opened'
  ));
