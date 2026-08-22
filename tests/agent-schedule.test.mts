import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  agentCadence, agentHealth, agentHealthLabels, agentIsDue, BACKOFF_MINUTES, backoffMinutes,
  DEGRADED_AFTER_FAILURES, LATE_AFTER_MINUTES, localParts, manualRunKey,
  MINIMUM_INTERVAL_MINUTES, nextRunAt, scheduledRunKey, withinBusinessHours,
} from "../lib/agent-schedule.ts";
import { decideAgentSchedule, nextAttemptInMinutes, type SchedulableAgent } from "../lib/agent-scheduler.ts";

/* O agendador é o lugar em que um erro fica invisível por semanas: ninguém
   percebe que um agente parou de rodar, só que "o dado está velho". Estes
   testes existem para que a decisão de enfileirar seja verificável sem esperar
   o tempo passar — o motivo de o módulo ser puro. */

const agent = (overrides: Partial<SchedulableAgent> = {}): SchedulableAgent => ({
  integrationId: "int-1",
  channel: "tangerino",
  displayName: "Tangerino",
  status: "connected",
  scheduleEnabled: true,
  cadence: "every_30_minutes",
  timeZone: "America/Sao_Paulo",
  nextRunAt: "2026-01-05T12:00:00.000Z",
  consecutiveFailures: 0,
  hasActiveJob: false,
  hasCredential: true,
  hasMapping: true,
  ...overrides,
});

/* -------------------------------------------------------------------------- *
 * Cadência
 * -------------------------------------------------------------------------- */

test("cadência desconhecida cai em manual, e manual não agenda nada", () => {
  assert.equal(agentCadence("inventada").key, "manual");
  assert.equal(agentCadence(null).key, "manual");
  assert.equal(nextRunAt({ cadence: "manual", from: new Date("2026-01-05T12:00:00Z") }), null);
});

test("nenhuma cadência automática é mais agressiva que o mínimo (§30)", () => {
  for (const cadence of ["every_15_minutes", "every_30_minutes", "hourly", "business_hours", "daily"]) {
    const definition = agentCadence(cadence);
    assert.ok(definition.intervalMinutes >= MINIMUM_INTERVAL_MINUTES,
      `${cadence} roda a cada ${definition.intervalMinutes} minutos, abaixo do piso de segurança`);
  }
});

test("cada cadência tem rótulo e explicação — ninguém escolhe enum", () => {
  for (const definition of [agentCadence("hourly"), agentCadence("daily"), agentCadence("manual")]) {
    assert.ok(definition.label.length > 3, `${definition.key} sem rótulo`);
    assert.ok(definition.description.length > 20, `${definition.key} sem explicação`);
  }
});

/* -------------------------------------------------------------------------- *
 * Fuso e expediente
 * -------------------------------------------------------------------------- */

test("o expediente é o de quem opera, não o do servidor (§84)", () => {
  // 12h UTC é 9h em São Paulo (dentro) e 21h em Tóquio (fora). Se o cálculo
  // usasse UTC, os dois responderiam igual — e o agente bateria no sistema de
  // origem de madrugada para metade dos clientes.
  const instant = new Date("2026-01-05T12:00:00Z"); // segunda-feira
  assert.equal(withinBusinessHours(instant, "America/Sao_Paulo"), true);
  assert.equal(withinBusinessHours(instant, "Asia/Tokyo"), false);
});

test("fim de semana não é expediente", () => {
  const saturday = new Date("2026-01-10T15:00:00Z");
  assert.equal(localParts(saturday, "America/Sao_Paulo").weekday, 6);
  assert.equal(withinBusinessHours(saturday, "America/Sao_Paulo"), false);
});

test("fuso inválido não derruba o agendador", () => {
  // O valor vem de configuração de cliente. Recusar com exceção pararia a
  // varredura inteira por causa de um grupo com o campo digitado errado.
  const instant = new Date("2026-01-05T12:00:00Z");
  assert.equal(localParts(instant, "Nao/Existe").timeZone, "America/Sao_Paulo");
  assert.doesNotThrow(() => withinBusinessHours(instant, "Nao/Existe"));
});

test("a cadência de expediente adia para o próximo horário útil", () => {
  // Sexta 17h30 em São Paulo: somar uma hora sai do expediente, e o próximo
  // horário válido é na segunda de manhã, não às 18h30 de sexta.
  const friday = new Date("2026-01-09T20:30:00Z");
  const next = nextRunAt({ cadence: "business_hours", from: friday, timeZone: "America/Sao_Paulo" });
  assert.ok(next, "cadência de expediente precisa devolver horário");
  assert.equal(withinBusinessHours(next!, "America/Sao_Paulo"), true);
  assert.ok(next!.getTime() > friday.getTime());
});

test("o avanço da cadência de expediente termina — fuso patológico não vira laço", () => {
  const next = nextRunAt({ cadence: "daily", from: new Date("2026-01-09T20:30:00Z"), timeZone: "Nao/Existe" });
  assert.ok(next instanceof Date);
});

/* -------------------------------------------------------------------------- *
 * Espera crescente
 * -------------------------------------------------------------------------- */

test("a espera cresce e para de crescer (§33)", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 12].map(backoffMinutes),
    [1, 5, 15, 60, 60, 60],
  );
  assert.equal(backoffMinutes(0), BACKOFF_MINUTES[0], "sem falha registrada, a menor espera");
});

test("a tabela de espera do TypeScript é a mesma escrita no SQL", async () => {
  // A duplicação é consciente: consultar o banco para desenhar um rótulo
  // custaria uma ida ao servidor por linha da lista. O que não pode é divergir.
  const source = await readFile(new URL("../lib/agent-scheduler.ts", import.meta.url), "utf8");
  for (const [failures, minutes] of [[4, 60], [3, 15], [2, 5]] as const) {
    const branch = failures === 4
      ? `WHEN consecutive_failures + 1 >= ${failures} THEN ${minutes}`
      : `WHEN consecutive_failures + 1 = ${failures} THEN ${minutes}`;
    assert.ok(source.includes(branch), `a espera de ${failures} falhas (${minutes} min) sumiu do SQL`);
    assert.equal(backoffMinutes(failures), minutes);
  }
  assert.ok(source.includes("ELSE 1 END"), "a primeira espera sumiu do SQL");
  assert.equal(backoffMinutes(1), 1);
  assert.equal(nextAttemptInMinutes(0), 0, "sem falha não há espera a anunciar");
  assert.equal(nextAttemptInMinutes(2), 5);
});

/* -------------------------------------------------------------------------- *
 * Estado do agente
 * -------------------------------------------------------------------------- */

const health = (overrides: Record<string, unknown> = {}) => agentHealth({
  status: "connected",
  scheduleEnabled: true,
  cadence: "hourly",
  lastRunAt: "2026-01-05T11:00:00.000Z",
  nextRunAt: "2026-01-05T12:00:00.000Z",
  consecutiveFailures: 0,
  lastRunFailed: false,
  now: new Date("2026-01-05T12:05:00Z"),
  ...overrides,
} as Parameters<typeof agentHealth>[0]);

test("pausado vence tudo — foi uma decisão humana (§22)", () => {
  assert.equal(health({ status: "paused", consecutiveFailures: 9, lastRunFailed: true }), "paused");
});

test("degradado vence erro, e erro vence atraso", () => {
  assert.equal(health({ consecutiveFailures: DEGRADED_AFTER_FAILURES, lastRunFailed: true }), "degraded");
  assert.equal(health({ consecutiveFailures: 1, lastRunFailed: true }), "error");
});

test("nunca executado não é erro", () => {
  assert.equal(health({ lastRunAt: null }), "never_run");
  assert.equal(health({ status: "needs_credentials" }), "needs_credentials");
});

test("atraso só existe com regra escrita, não com palpite de relógio", () => {
  const late = new Date(Date.parse("2026-01-05T12:00:00Z") + (LATE_AFTER_MINUTES + 1) * 60_000);
  assert.equal(health({ now: late }), "late");
  // Um minuto dentro da tolerância ainda é "ativo": não se acende alarme por
  // um ciclo que está para acontecer.
  const almost = new Date(Date.parse("2026-01-05T12:00:00Z") + (LATE_AFTER_MINUTES - 1) * 60_000);
  assert.equal(health({ now: almost }), "active");
  // Sem agendamento não existe atraso — não há horário prometido a descumprir.
  assert.equal(health({ now: late, scheduleEnabled: false }), "active");
  assert.equal(health({ now: late, cadence: "manual" }), "active");
});

test("todo estado tem rótulo, tom e explicação", () => {
  for (const [key, meta] of Object.entries(agentHealthLabels)) {
    assert.ok(meta.label.length > 2, `${key} sem rótulo`);
    assert.ok(meta.detail.length > 20, `${key} sem explicação para quem opera`);
    assert.ok(["critical", "warning", "neutral", "positive"].includes(meta.tone));
  }
});

/* -------------------------------------------------------------------------- *
 * Elegibilidade
 * -------------------------------------------------------------------------- */

const now = new Date("2026-01-05T13:00:00Z");
const decide = (overrides: Partial<SchedulableAgent> = {}) => decideAgentSchedule([agent(overrides)], now)[0];

test("agente pronto e vencido entra na fila", () => {
  const decision = decide();
  assert.equal(decision.due, true);
  assert.equal(decision.reason, "ok");
});

test("custo: pausado, sem credencial ou sem mapeamento nem chega a ser enfileirado (§87)", () => {
  assert.deepEqual(
    [
      decide({ status: "paused" }).reason,
      decide({ status: "needs_credentials" }).reason,
      decide({ hasCredential: false }).reason,
      decide({ hasMapping: false }).reason,
      decide({ scheduleEnabled: false }).reason,
      decide({ cadence: "manual" }).reason,
    ],
    ["paused", "not_connected", "missing_credential", "missing_mapping", "schedule_disabled", "manual_only"],
  );
  assert.ok([
    decide({ status: "paused" }), decide({ hasCredential: false }), decide({ hasMapping: false }),
  ].every((decision) => decision.due === false));
});

test("execução já enfileirada não vira uma segunda (§31)", () => {
  const decision = decide({ hasActiveJob: true });
  assert.equal(decision.due, false);
  assert.equal(decision.reason, "already_queued");
});

test("horário futuro espera; horário sem preencher roda no primeiro ciclo", () => {
  assert.equal(decide({ nextRunAt: "2026-01-05T23:00:00.000Z" }).reason, "not_due");
  assert.equal(decide({ nextRunAt: null }).due, true);
});

test("cadência de expediente não dispara de madrugada", () => {
  const dawn = new Date("2026-01-05T06:00:00Z"); // 3h em São Paulo
  const [decision] = decideAgentSchedule([agent({ cadence: "business_hours" })], dawn);
  assert.equal(decision.due, false);
  assert.equal(decision.reason, "outside_business_hours");
});

test("o motivo da recusa é sempre nomeado — nunca um `false` mudo", () => {
  const reasons = decideAgentSchedule([
    agent({ status: "paused" }), agent({ hasMapping: false }), agent(),
  ], now).map((decision) => decision.reason);
  assert.ok(reasons.every((reason) => typeof reason === "string" && reason.length > 1));
});

/* -------------------------------------------------------------------------- *
 * Idempotência
 * -------------------------------------------------------------------------- */

test("duas varreduras na mesma janela produzem a mesma chave (§8)", () => {
  const first = scheduledRunKey({ agentKey: "tangerino", cadence: "every_30_minutes", at: new Date("2026-01-05T12:01:00Z") });
  const second = scheduledRunKey({ agentKey: "tangerino", cadence: "every_30_minutes", at: new Date("2026-01-05T12:29:59Z") });
  const third = scheduledRunKey({ agentKey: "tangerino", cadence: "every_30_minutes", at: new Date("2026-01-05T12:31:00Z") });
  assert.equal(first, second, "duas chamadas no mesmo intervalo viraram duas execuções");
  assert.notEqual(first, third);
});

test("a chave não carrega nada que varie por execução", () => {
  const key = scheduledRunKey({ agentKey: "solides", cadence: "hourly", at: new Date("2026-01-05T12:34:56.789Z") });
  assert.ok(!/\d{2}:34/u.test(key), "o minuto exato entrou na chave e ela deixou de ser idempotente");
  assert.ok(key.startsWith("agent:solides:"));
  assert.ok(key.length >= 8, "chave curta demais é recusada pelo enfileiramento");
});

test("agentes diferentes não compartilham chave", () => {
  const at = new Date("2026-01-05T12:00:00Z");
  assert.notEqual(
    scheduledRunKey({ agentKey: "tangerino", cadence: "hourly", at }),
    scheduledRunKey({ agentKey: "solides", cadence: "hourly", at }),
  );
});

test("o disparo manual tem janela curta, e não colide com o agendado (§24)", () => {
  const at = new Date("2026-01-05T12:02:00Z");
  const manual = manualRunKey({ agentKey: "tangerino", at });
  assert.notEqual(manual, scheduledRunKey({ agentKey: "tangerino", cadence: "every_30_minutes", at }));
  assert.equal(manual, manualRunKey({ agentKey: "tangerino", at: new Date("2026-01-05T12:04:59Z") }),
    "dois cliques seguidos precisam virar uma execução só");
  assert.notEqual(manual, manualRunKey({ agentKey: "tangerino", at: new Date("2026-01-05T12:06:00Z") }));
});

/* -------------------------------------------------------------------------- *
 * Fronteira
 * -------------------------------------------------------------------------- */

test("o módulo de cadência não fala com o banco", async () => {
  const source = await readFile(new URL("../lib/agent-schedule.ts", import.meta.url), "utf8");
  for (const forbidden of [/getD1/u, /prepare\(/u, /SELECT /u, /fetch\(/u]) {
    assert.ok(!forbidden.test(source),
      `a decisão de cadência passou a depender de efeito externo: ${forbidden}`);
  }
});
