import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * O defeito que estes testes protegem: sincronizar enfileirava trabalho que
 * nunca saía da fila, porque nada chamava o executor. Não havia erro em lugar
 * nenhum — a fila só não andava.
 */
test("existe disparo agendado para o executor de integrações", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as { crons?: Array<{ path: string; schedule: string }> };
  const cron = (config.crons ?? []).find((entry) => entry.path === "/api/cron/integrations");
  assert.ok(cron, "a fila depende de um agendamento declarado no vercel.json");
  assert.match(cron.schedule, /^[\d*/,\- ]+$/u, "o agendamento precisa ser uma expressão cron válida");
});

test("o disparo agendado exige segredo e respeita o isolamento por workspace", async () => {
  const route = await readFile(new URL("../app/api/cron/integrations/route.ts", import.meta.url), "utf8");
  // A Vercel Cron só manda Bearer: autenticar pelo cabeçalho do executor deixaria a rota aberta.
  assert.match(route, /authorization/u);
  assert.match(route, /timingSafeEqual/u, "comparação de segredo precisa ser em tempo constante");
  assert.match(route, /CRON_SECRET/u);
  assert.match(route, /FDP_INTEGRATION_WORKER_SECRET/u);
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

  // Nenhum segredo pode ir para o log.
  assert.doesNotMatch(route, /log\([^)]*SECRET/u);
});
