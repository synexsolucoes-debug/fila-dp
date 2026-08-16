import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyOperationalHealth, worstSeverity, OPERATIONAL_HEALTH_THRESHOLDS } from "../lib/operational-health.ts";

/**
 * O que estes testes protegem: `/api/health` respondia 200 e "Banco na mesma
 * versão do aplicativo" enquanto a varredura agendada das integrações morria a
 * cada meia hora com `syntax error at or near "grant"`. A fila de todos os
 * clientes estava parada e o health check dizia que estava tudo bem, porque só
 * olhava aplicação, schema e configuração.
 *
 * A regra que não pode voltar atrás: fila que não anda é crítico.
 */

const counters = (over: Partial<{
  queue: Partial<ReturnType<typeof baseQueue>>;
  connectors: Partial<ReturnType<typeof baseConnectors>>;
  webhooks: Partial<ReturnType<typeof baseWebhooks>>;
}> = {}) => ({
  queue: { ...baseQueue(), ...over.queue },
  connectors: { ...baseConnectors(), ...over.connectors },
  webhooks: { ...baseWebhooks(), ...over.webhooks },
});

const baseQueue = () => ({
  pending: 0, delayed: 0, stuck: 0, deadLetter: 0, failuresLast24h: 0,
  lastCompletedAt: null as string | null, lastSuccessAt: null as string | null, lastFailureAt: null as string | null,
});
const baseConnectors = () => ({ connected: 0, failing: 0, overdue: 0, lastSyncAt: null as string | null });
const baseWebhooks = () => ({ pending: 0, failed: 0, deadLetter: 0, deliveredLast24h: 0 });

test("sem pendência a operação é saudável", () => {
  const verdict = classifyOperationalHealth(counters());
  assert.equal(verdict.severity, "saudavel");
});

test("fila que não é drenada é crítica, não apenas atenção", () => {
  // Este é o incidente: job disponível há mais de dois ciclos da varredura.
  const verdict = classifyOperationalHealth(counters({ queue: { delayed: 1 } }));
  assert.equal(verdict.severity, "critico");
  assert.match(verdict.detail, /não está sendo drenada/u);
  // A mensagem precisa dizer o que olhar, senão o alerta não ajuda quem atende.
  assert.match(verdict.detail, /varredura agendada/u);
});

test("execução que esgotou as tentativas é crítica: ela não anda sozinha", () => {
  const verdict = classifyOperationalHealth(counters({ queue: { deadLetter: 2 } }));
  assert.equal(verdict.severity, "critico");
  assert.match(verdict.detail, /esgotaram as tentativas/u);
});

test("execução presa com reserva vencida degrada, mas se resolve sozinha", () => {
  const verdict = classifyOperationalHealth(counters({ queue: { stuck: 1 } }));
  assert.equal(verdict.severity, "degradado");
  assert.match(verdict.detail, /voltam à fila/u);
});

test("integração em erro degrada a saúde apresentada", () => {
  const verdict = classifyOperationalHealth(counters({ connectors: { connected: 3, failing: 1 } }));
  assert.equal(verdict.severity, "degradado");
  assert.match(verdict.detail, /em erro/u);
});

test("retentativa isolada não degrada; repetição sim", () => {
  const dentro = classifyOperationalHealth(counters({ queue: { failuresLast24h: OPERATIONAL_HEALTH_THRESHOLDS.RECENT_FAILURE_BUDGET } }));
  assert.equal(dentro.severity, "saudavel", "retentativa é comportamento normal da fila");

  const acima = classifyOperationalHealth(counters({ queue: { failuresLast24h: OPERATIONAL_HEALTH_THRESHOLDS.RECENT_FAILURE_BUDGET + 1 } }));
  assert.equal(acima.severity, "degradado");
});

test("fila andando dentro do prazo é atenção, não falha", () => {
  const verdict = classifyOperationalHealth(counters({ queue: { pending: 4 } }));
  assert.equal(verdict.severity, "atencao");
});

test("conector com horário vencido chama atenção antes de virar erro", () => {
  const verdict = classifyOperationalHealth(counters({ connectors: { connected: 1, overdue: 1 } }));
  assert.equal(verdict.severity, "atencao");
  assert.match(verdict.detail, /atrasada/u);
});

test("o pior sinal manda no veredito combinado", () => {
  assert.equal(worstSeverity("saudavel", "atencao"), "atencao");
  assert.equal(worstSeverity("degradado", "atencao"), "degradado");
  assert.equal(worstSeverity("saudavel", "critico", "atencao"), "critico");
  assert.equal(worstSeverity("saudavel", "saudavel"), "saudavel");
});

test("o limite de atraso acompanha a cadência real da varredura", () => {
  // A varredura roda aos minutos 17 e 47: um ciclo é meia hora. Se a cadência
  // mudar sem que estes limites mudem juntos, o alerta vira ruído ou silêncio.
  assert.equal(OPERATIONAL_HEALTH_THRESHOLDS.CYCLE_MINUTES, 30);
  assert.equal(OPERATIONAL_HEALTH_THRESHOLDS.DELAYED_AFTER_MINUTES, 60);
});

test("a rota de saúde considera a operação e não só o schema", async () => {
  const route = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  assert.match(route, /checkOperationalHealth/u, "a saúde operacional precisa entrar no veredito");
  assert.match(route, /worstSeverity/u);
  // Fila parada tem de acordar o monitor, não virar linha de corpo que ninguém lê.
  assert.match(route, /operation\?\.severity === "critico"/u);
  assert.match(route, /status: unavailable \? 503 : 200/u);
  // O detalhe por workspace é de quem administra a plataforma, não do público.
  assert.match(route, /isPlatformAdmin/u);
});

test("o relatório operacional só entrega detalhe por workspace a quem administra", async () => {
  const source = await readFile(new URL("../lib/operational-health.ts", import.meta.url), "utf8");
  assert.match(source, /includeDetail \? report : \{ \.\.\.report, failingWorkspaces: undefined \}/u);
  // A varredura percorre tenant a tenant com a conexão presa: a fila tem FORCE RLS.
  assert.match(source, /getScopedD1\(\{ workspaceId, userId: null \}\)/u);
  // Um tenant ilegível não pode apagar o retrato dos demais.
  assert.match(source, /catch \{/u);
});
