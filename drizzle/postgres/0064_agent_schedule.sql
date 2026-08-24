-- Execução automática dos agentes (§27 a §35, §80 a §87).
--
-- ## Por que nenhuma tabela nova
--
-- A §81 manda conferir antes de criar, e a conferência devolveu tudo o que um
-- agendador precisa, já pronto e já em produção:
--
--   * `fdp_integration_jobs` — fila com `available_at` (espera), `lease_token` e
--     `lease_expires_at` (reserva), `attempt`/`max_attempts` (retentativa) e o
--     estado `dead_letter` (item irrecuperável);
--   * `fdp_integration_sync_runs` — a execução em si, com contadores e erro;
--   * `fdp_integration_run_logs` — o log operacional, por execução e em ordem;
--   * `fdp_integrations.next_sync_at` / `schedule_enabled` — o gatilho por
--     conector, já lido pela varredura agendada.
--
-- Criar `fdp_agent_jobs` ao lado disso daria dois lugares para pausar a mesma
-- automação, duas filas para drenar e duas verdades sobre o que está rodando —
-- e é assim que se descobre, no pior momento, que o agente "parado" continuava
-- executando pelo outro caminho. O que faltava não era estrutura: era **quando**
-- enfileirar e o que fazer quando a origem está fora do ar.
--
-- ## O que esta migration acrescenta
--
-- Quatro colunas em `fdp_integrations`, todas aditivas e com padrão que preserva
-- o comportamento atual, mais um índice único parcial que transforma em
-- invariante do banco aquilo que hoje é só cuidado da aplicação.
--
--   * `schedule_cadence` — a cadência declarada. `manual` é o padrão: nenhum
--     conector passa a rodar sozinho por causa desta migration.
--   * `schedule_timezone` — o fuso do grupo. A persistência continua em UTC; o
--     fuso existe para "de hora em hora, no expediente" significar o expediente
--     de quem opera, e não o do servidor (§84).
--   * `consecutive_failures` — quantas falhas seguidas. É o que sustenta a
--     espera crescente (§33) e a marcação de degradado (§34) sem inventar
--     estado a partir do relógio.
--   * `degraded_since` — desde quando. Sem isso, "degradado" é um booleano que
--     não conta há quanto tempo o dado do cliente está velho.
--
-- ## O índice único parcial
--
-- A §31 exige que dois runners não executem o mesmo agente ao mesmo tempo no
-- mesmo grupo. A reserva por `lease_token` já impede dois runners de pegarem o
-- **mesmo job**; ela não impede que existam **dois jobs** para o mesmo conector.
-- O índice fecha isso no banco: no máximo um job não terminal por (grupo,
-- conector). O mesmo padrão que `fdp_sankhya_active_run_uq` já usa para as
-- execuções — aqui aplicado à fila, e para todos os conectores.
--
-- O preflight recusa em vez de corrigir: se a base já tiver duplicidade, a
-- migration para e diz quantas são. Cancelar job de cliente por palpite é pior
-- do que parar o deploy.
--
-- ## Backfill do Tangerino
--
-- A varredura de hoje enfileira o Tangerino a cada ciclo de 30 minutos, por uma
-- regra escrita no código da rota. Ao generalizar a regra para a cadência, esse
-- conector precisa continuar rodando exatamente como roda — por isso o backfill
-- o declara `every_30_minutes` com agendamento ligado. Nenhum outro canal é
-- tocado: `sankhya_browser` mantém a própria configuração e o próprio caminho.
SELECT pg_advisory_xact_lock(hashtext('0064_agent_schedule'));
--> statement-breakpoint

ALTER TABLE "fdp_integrations"
  ADD COLUMN IF NOT EXISTS "schedule_cadence" text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE "fdp_integrations"
  ADD COLUMN IF NOT EXISTS "schedule_timezone" text NOT NULL DEFAULT 'America/Sao_Paulo';
--> statement-breakpoint
ALTER TABLE "fdp_integrations"
  ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "fdp_integrations"
  ADD COLUMN IF NOT EXISTS "degraded_since" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "fdp_integrations" DROP CONSTRAINT IF EXISTS "fdp_integrations_schedule_cadence_check";
--> statement-breakpoint
ALTER TABLE "fdp_integrations"
  ADD CONSTRAINT "fdp_integrations_schedule_cadence_check" CHECK ("schedule_cadence" IN (
    'manual', 'every_15_minutes', 'every_30_minutes', 'hourly', 'business_hours', 'daily'
  ));
--> statement-breakpoint

ALTER TABLE "fdp_integrations" DROP CONSTRAINT IF EXISTS "fdp_integrations_failures_check";
--> statement-breakpoint
ALTER TABLE "fdp_integrations"
  ADD CONSTRAINT "fdp_integrations_failures_check" CHECK ("consecutive_failures" >= 0);
--> statement-breakpoint

-- Fuso vazio seria pior do que fuso errado: o cálculo cairia no padrão sem
-- ninguém perceber que a configuração ficou pela metade.
ALTER TABLE "fdp_integrations" DROP CONSTRAINT IF EXISTS "fdp_integrations_timezone_check";
--> statement-breakpoint
ALTER TABLE "fdp_integrations"
  ADD CONSTRAINT "fdp_integrations_timezone_check" CHECK (length("schedule_timezone") BETWEEN 3 AND 60);
--> statement-breakpoint

-- Degradado sem data, ou data sem degradação, são estados que mentem para quem
-- lê o painel. Ou o conector acumulou falhas e tem desde quando, ou não tem
-- nenhuma das duas coisas.
ALTER TABLE "fdp_integrations" DROP CONSTRAINT IF EXISTS "fdp_integrations_degraded_check";
--> statement-breakpoint
ALTER TABLE "fdp_integrations"
  ADD CONSTRAINT "fdp_integrations_degraded_check"
  CHECK (("degraded_since" IS NULL) OR ("consecutive_failures" > 0));
--> statement-breakpoint

DO $$
DECLARE duplicados integer;
BEGIN
  SELECT count(*) INTO duplicados FROM (
    SELECT 1 FROM "fdp_integration_jobs"
    WHERE "status" IN ('queued', 'leased')
    GROUP BY "workspace_id", "integration_id" HAVING count(*) > 1
  ) excedentes;
  IF duplicados > 0 THEN
    RAISE EXCEPTION
      'Existem % conectores com mais de uma execução ativa na fila. Drene ou cancele as duplicadas antes de aplicar 0064: a partir dela o banco passa a admitir uma só por conector.',
      duplicados;
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fdp_integration_jobs_active_uq"
  ON "fdp_integration_jobs" ("workspace_id", "integration_id")
  WHERE "status" IN ('queued', 'leased');
--> statement-breakpoint

-- Índice do agendador: a varredura pergunta "quem venceu?" a cada ciclo, e sem
-- isto a pergunta vira leitura sequencial da tabela de conectores de todos os
-- grupos, uma vez por grupo.
CREATE INDEX IF NOT EXISTS "fdp_integrations_due_idx"
  ON "fdp_integrations" ("workspace_id", "next_sync_at")
  WHERE "schedule_enabled" = 1;
--> statement-breakpoint

-- ## Reentrega contada, e não só registrada
--
-- A §37 pede que o Teams mostre quantos eventos chegaram e quantos foram
-- deduplicados. O primeiro número existe; o segundo não existia em lugar nenhum
-- — a reentrega era detectada pelo índice único, escrita no log estruturado e
-- esquecida. Contá-la na própria linha do evento é o menor acréscimo possível:
-- nenhuma tabela nova, nenhum contador paralelo para alguém esquecer de
-- incrementar, e o número passa a poder ser somado por conector.
--
-- `retry_count` não serve: ele conta retentativa de **processamento**, que é
-- outra coisa. Um evento pode ser reentregue sem nunca ter falhado.
ALTER TABLE "fdp_integration_events"
  ADD COLUMN IF NOT EXISTS "duplicate_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "fdp_integration_events" DROP CONSTRAINT IF EXISTS "fdp_integration_events_duplicate_check";
--> statement-breakpoint
ALTER TABLE "fdp_integration_events"
  ADD CONSTRAINT "fdp_integration_events_duplicate_check"
  CHECK ("duplicate_count" >= 0 AND "duplicate_count" <= 100000);
--> statement-breakpoint

-- Preserva o comportamento atual do Tangerino, que a varredura enfileirava por
-- regra escrita no código da rota.
UPDATE "fdp_integrations"
  SET "schedule_cadence" = 'every_30_minutes',
      "schedule_enabled" = 1,
      "next_sync_at" = COALESCE("next_sync_at", CURRENT_TIMESTAMP)
  WHERE "channel" = 'tangerino' AND "schedule_cadence" = 'manual';
