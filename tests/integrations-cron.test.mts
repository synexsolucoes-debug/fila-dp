import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * O defeito que estes testes protegem: sincronizar enfileirava trabalho que
 * nunca saía da fila, porque nada chamava o executor. Não havia erro em lugar
 * nenhum — a fila só não andava.
 */
test("existe disparo agendado para o executor de integrações", async () => {
  const workflow = await readFile(new URL("../.github/workflows/integrations-cron.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/u, "a fila depende de um agendamento de poucos minutos");
  assert.match(workflow, /Authorization: Bearer/u);
  assert.match(workflow, /workflow_dispatch/u, "precisa ser disparável à mão para depuração");
  // O passo tem de falhar quando o executor recusa, senão a fila para em silêncio de novo.
  assert.match(workflow, /exit 1/u);
});

test("o vercel.json não declara cron: a conta Hobby recusa o deploy inteiro", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as { crons?: unknown[] };
  // "Hobby accounts are limited to daily cron jobs" derruba o build, não só o cron.
  assert.equal(config.crons, undefined, "declarar cron aqui quebra o deploy enquanto a conta for Hobby");
});

test("o disparo agendado exige segredo e respeita o isolamento por workspace", async () => {
  const route = await readFile(new URL("../app/api/cron/integrations/route.ts", import.meta.url), "utf8");
  // A Vercel Cron só manda Bearer: autenticar pelo cabeçalho do executor deixaria a rota aberta.
  assert.match(route, /authorization/u);
  assert.match(route, /timingSafeEqual/u, "comparação de segredo precisa ser em tempo constante");
  assert.match(route, /CRON_SECRET/u);
  assert.match(route, /FDP_INTEGRATION_WORKER_SECRET/u);
  assert.match(route, /GITHUB_INTEGRATIONS_CRON_SECRET/u);
  assert.match(route, /status: 401/u);
  // Segredo curto não é aceito nem quando confere.
  assert.match(route, /MINIMUM_SECRET_LENGTH = 32/u);

  // A fila tem RLS por workspace: cada tenant é processado com a conexão presa a ele,
  // e não confiando no contexto assíncrono sobreviver ao laço.
  assert.match(route, /getScopedD1\(\{ workspaceId: workspace\.id/u);
  assert.doesNotMatch(route, /setTenantContext/u);

  // Um tenant com fila grande não pode consumir a janela inteira, e a resposta
  // precisa sair antes do limite da função.
  assert.match(route, /MAX_JOBS_PER_WORKSPACE/u);
  assert.match(route, /Date\.now\(\) < deadline/u);
  assert.match(route, /maxDuration/u);

  // O agendamento precisa iniciar a consulta da Sólides DP; apenas drenar jobs
  // manuais deixaria novas admissões invisíveis até alguém clicar em sincronizar.
  assert.match(route, /queueIntegrationRun/u);
  assert.match(route, /integration\.channel = 'tangerino'/u);
  assert.match(route, /candidate\.resource_type = 'admissions'/u);
  assert.match(route, /triggerType: "scheduled"/u);
  assert.match(route, /SCHEDULE_INTERVAL_MS = 5 \* 60 \* 1000/u);
  assert.match(route, /pending\.status IN \('queued', 'leased'\)/u, "não pode acumular consultas concorrentes do mesmo conector");

  // Nenhum segredo pode ir para o log.
  assert.doesNotMatch(route, /log\([^)]*SECRET/u);
});
