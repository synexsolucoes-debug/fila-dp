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
  assert.match(workflow, /cron: "17,47 \* \* \* \*"/u, "a fila mantém duas varreduras por hora dentro da franquia gratuita");
  assert.match(workflow, /Authorization: Bearer/u);
  assert.match(workflow, /workflow_dispatch/u, "precisa ser disparável à mão para depuração");
  // O passo tem de falhar quando o executor recusa, senão a fila para em silêncio de novo.
  assert.match(workflow, /exit 1/u);
  assert.match(workflow, /gh workflow run sankhya-worker\.yml/u, "o cron precisa acordar o RPA sem token permanente quando houver fila");
  assert.match(workflow, /actions: write/u, "o token efêmero recebe somente a permissão necessária para disparar o worker");
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

  // O agendamento precisa iniciar a consulta; apenas drenar jobs manuais
  // deixaria novas admissões invisíveis até alguém clicar em sincronizar.
  assert.match(route, /queueIntegrationRun/u);
  assert.match(route, /triggerType: "scheduled"/u);
  assert.match(route, /sankhyaPending/u);
  assert.match(route, /wakeSankhyaWorker/u);
  // Quem entra em cada ciclo deixou de ser uma regra escrita aqui dentro e
  // passou a ser a cadência declarada no conector (§29). A garantia é a mesma:
  // a varredura cria execução, ela não só drena o que já existe.
  assert.match(route, /listSchedulableAgents/u);
  assert.match(route, /decideAgentSchedule/u);
  assert.match(route, /prepareNextRun/u, "sem gravar o próximo horário, o conector sairia da varredura para sempre");

  // Nenhum segredo pode ir para o log.
  assert.doesNotMatch(route, /log\([^)]*SECRET/u);
});

test("a decisão de quem roda continua sendo por conector, e sem execuções concorrentes", async () => {
  const scheduler = await readFile(new URL("../lib/agent-scheduler.ts", import.meta.url), "utf8");
  /* Os canais que a varredura dispara. Eram os conectores de API do Tangerino e
     da Sólides; a decisão de produto os aposentou, e mantê-los aqui deixaria
     automação rodando sobre dado de cliente sem cartão na tela e sem botão de
     pausa ao alcance de quem opera. O Sankhya tem portão de módulo e worker
     próprios, e continua pelo caminho dele. */
  assert.match(scheduler, /i\.channel IN \('tangerino_browser'\)/u);
  // Mapeamento publicado e credencial ativa são pré-requisito: enfileirar sem
  // eles gasta a janela da varredura para produzir uma falha previsível (§87).
  assert.match(scheduler, /m\.status = 'active' AND m\.direction IN \('inbound', 'bidirectional'\)/u);
  assert.match(scheduler, /c\.credential_type = 'provider_auth' AND c\.status = 'active'/u);
  assert.match(scheduler, /j\.status IN \('queued', 'leased'\)/u, "não pode acumular consultas concorrentes do mesmo conector");

  const engine = await readFile(new URL("../lib/integration-engine.ts", import.meta.url), "utf8");
  assert.match(engine, /active\.status IN \('queued', 'leased'\)/u,
    "o enfileiramento precisa recusar o segundo job do mesmo conector, e não estourar restrição");

  // A janela de idempotência do disparo agendado saiu da rota e virou regra
  // testável, derivada da cadência em vez de um intervalo fixo.
  const schedule = await readFile(new URL("../lib/agent-schedule.ts", import.meta.url), "utf8");
  assert.match(schedule, /export function scheduledRunKey/u);
  assert.match(schedule, /Math\.floor\(input\.at\.getTime\(\) \/ windowMs\) \* windowMs/u,
    "a chave precisa vir da janela, e não do instante — senão duas varreduras viram duas execuções");
});
