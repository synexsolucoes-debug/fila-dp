import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasCapability } from "../lib/authorization.ts";
import { actionDefinitions } from "../lib/action-center.ts";
import {
  TIME_CALC_VERSION,
  assertApprovable,
  assertExportable,
  assertHourEventTarget,
  assertTimeSheetMutable,
  assertTimeTransition,
  calculateTimeDay,
  calculateTimeSheet,
  convertMinutes,
  formatDuration,
  hourEventTargetFields,
  parseTimeEntryPayload,
  planTimeExport,
  renderTimeExportCsv,
  sanitizePunches,
  timeSheetTransitions,
} from "../lib/time-tracking.ts";
import { previewTimeExport } from "../lib/time-service.ts";

const day = (over: Partial<Parameters<typeof calculateTimeDay>[0]> = {}) => calculateTimeDay({
  entryDate: "2026-07-06",
  dayType: "regular",
  expectedMinutes: 480,
  punches: [{ in: "08:00", out: "12:00" }, { in: "13:00", out: "17:00" }],
  ...over,
}, { today: "2026-07-31" });

/* -------------------------------------------------------------------------- */
/* §22 — o coração do módulo                                                   */
/* -------------------------------------------------------------------------- */

test("evento do tipo hora nunca pode ser mapeado para valor", () => {
  for (const forbidden of ["value", "amount", "valor", "Montante", "MONEY"]) {
    assert.throws(
      () => assertHourEventTarget(forbidden),
      (error: { code?: string }) => error.code === "HOUR_EVENT_VALUE_TARGET_FORBIDDEN",
      `${forbidden} deveria ser recusado como destino`,
    );
  }
  for (const allowed of hourEventTargetFields) {
    assert.equal(assertHourEventTarget(allowed), allowed);
  }
  // O vocabulário não tem "valor" nem como opção desabilitada.
  assert.deepEqual([...hourEventTargetFields], ["quantity", "reference", "index"]);
});

test("sem mapeamento configurado a exportação é bloqueada, e o bloqueio nomeia o evento", () => {
  const plan = planTimeExport({
    events: [{ eventCode: "overtime_50", minutes: 120 }, { eventCode: "night_hours", minutes: 60 }],
    mappings: [{ eventCode: "overtime_50", rubricCode: "0910", targetField: "quantity", unit: "hours_decimal", destination: "folha" }],
  });
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.missingMappings, ["night_hours"]);
  assert.equal(plan.lines.length, 1);

  assert.throws(
    () => assertExportable(plan),
    (error: { code?: string; message?: string }) =>
      error.code === "HOUR_EVENT_MAPPING_REQUIRED" && /janela noturna/u.test(String(error.message)),
  );
});

test("mapeamento inativo conta como ausente: desligar a rubrica volta a bloquear", () => {
  const plan = planTimeExport({
    events: [{ eventCode: "overtime_50", minutes: 90 }],
    mappings: [{ eventCode: "overtime_50", rubricCode: "0910", targetField: "quantity", unit: "minutes", destination: "folha", status: "inactive" }],
  });
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.missingMappings, ["overtime_50"]);
});

test("a linha exportada leva quantidade e destino, e não tem para onde mandar dinheiro", () => {
  const plan = planTimeExport({
    events: [
      { eventCode: "overtime_50", minutes: 150 },
      { eventCode: "night_hours", minutes: 90 },
      { eventCode: "late_hours", minutes: 45 },
    ],
    mappings: [
      { eventCode: "overtime_50", rubricCode: "0910", targetField: "quantity", unit: "hours_decimal", destination: "folha" },
      { eventCode: "night_hours", rubricCode: "0920", targetField: "reference", unit: "hours_minutes", destination: "folha" },
      { eventCode: "late_hours", rubricCode: "0930", targetField: "index", unit: "minutes", destination: "folha" },
    ],
  });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.lines.map((line) => [line.rubricCode, line.targetField, line.quantity]), [
    ["0930", "index", 45],
    ["0920", "reference", "01:30"],
    ["0910", "quantity", 2.5],
  ]);
  for (const line of plan.lines) {
    for (const forbidden of ["value", "amount", "valor", "money"]) {
      assert.equal(Object.hasOwn(line, forbidden), false, `a linha não pode ter campo ${forbidden}`);
    }
  }
});

test("o CSV da exportação não possui coluna de valor", () => {
  const csv = renderTimeExportCsv([{
    eventCode: "overtime_50", rubricCode: "0910", targetField: "quantity", unit: "hours_decimal",
    destination: "folha", minutes: 120, quantity: 2, registrationNumber: "0001", employeeName: "Maria Souza",
  }]);
  const [header, row] = csv.split("\n");
  assert.equal(header, "matricula;colaborador;rubrica;evento;campo_destino;unidade;quantidade");
  assert.doesNotMatch(header, /valor|value|amount/iu);
  assert.equal(row, "0001;Maria Souza;0910;overtime_50;quantity;hours_decimal;2");
});

test("evento apurado com zero minuto não vira linha nem bloqueio", () => {
  const plan = planTimeExport({ events: [{ eventCode: "overtime_50", minutes: 0 }], mappings: [] });
  assert.deepEqual(plan.missingMappings, []);
  assert.deepEqual(plan.ignoredZeroEvents, ["overtime_50"]);
  assert.equal(plan.ready, false);
  assert.throws(() => assertExportable(plan), (error: { code?: string }) => error.code === "TIME_EXPORT_EMPTY");
});

test("a conversão de unidade é explícita e não arredonda hora para inteiro", () => {
  assert.equal(convertMinutes(90, "hours_decimal"), 1.5);
  assert.equal(convertMinutes(90, "hours_minutes"), "01:30");
  assert.equal(convertMinutes(90, "minutes"), 90);
  assert.equal(convertMinutes(100, "hours_decimal"), 1.6667);
});

/* -------------------------------------------------------------------------- */
/* Apuração do dia                                                             */
/* -------------------------------------------------------------------------- */

test("dia útil cumprido não gera evento nem inconsistência", () => {
  const result = day();
  assert.equal(result.workedMinutes, 480);
  assert.equal(result.balanceMinutes, 0);
  assert.deepEqual(result.events, {});
  assert.deepEqual(result.issues, []);
});

test("saldo positivo vira hora extra de dia útil e exige justificativa", () => {
  const withoutReason = day({ punches: [{ in: "08:00", out: "12:00" }, { in: "13:00", out: "19:00" }] });
  assert.equal(withoutReason.events.overtime_50, 120);
  assert.ok(withoutReason.issues.some((issue) => issue.kind === "overtime_without_justification" && issue.severity === "warning"));

  const withReason = day({ punches: [{ in: "08:00", out: "12:00" }, { in: "13:00", out: "19:00" }], justification: "Fechamento de folha" });
  assert.equal(withReason.events.overtime_50, 120);
  assert.deepEqual(withReason.issues, []);
});

test("trabalho em descanso e feriado é hora extra de 100%, não de dia útil", () => {
  const rest = day({ dayType: "rest", expectedMinutes: null, punches: [{ in: "09:00", out: "13:00" }], justification: "Escala de plantão" });
  assert.equal(rest.events.overtime_100, 240);
  assert.equal(rest.events.overtime_50, undefined);
  assert.equal(rest.expectedMinutes, 0);
});

test("dia útil sem marcação vira falta em horas e inconsistência bloqueante", () => {
  const result = day({ punches: [] });
  assert.equal(result.events.absence_hours, 480);
  const issue = result.issues.find((item) => item.kind === "missing_punch");
  assert.ok(issue);
  assert.equal(issue?.severity, "blocking");
});

test("trabalho parcial vira atraso, não falta", () => {
  const result = day({ punches: [{ in: "09:00", out: "12:00" }, { in: "13:00", out: "17:00" }] });
  assert.equal(result.events.late_hours, 60);
  assert.equal(result.events.absence_hours, undefined);
});

test("marcação em férias ou licença é acusada, nunca convertida em evento", () => {
  const result = day({ dayType: "vacation", expectedMinutes: null, punches: [{ in: "08:00", out: "12:00" }] });
  assert.deepEqual(Object.keys(result.events), []);
  const issue = result.issues.find((item) => item.kind === "work_on_non_working_day");
  assert.ok(issue);
  assert.equal(issue?.severity, "blocking");
});

test("entrada sem saída é bloqueante e não conta minuto trabalhado", () => {
  const result = day({ punches: [{ in: "08:00", out: "" }] });
  assert.equal(result.workedMinutes, 0);
  assert.ok(result.issues.some((issue) => issue.kind === "odd_punch_count" && issue.severity === "blocking"));
});

test("jornada que vira o dia é contada, não descartada", () => {
  const result = day({ punches: [{ in: "22:00", out: "06:00" }], expectedMinutes: 480, justification: "Turno noturno" });
  assert.equal(result.workedMinutes, 480);
  // Janela noturna das 22h às 5h: sete horas dentro dela.
  assert.equal(result.nightMinutes, 420);
  assert.equal(result.events.night_hours, 420);
});

test("hora noturna é entregue sem a conversão legal — a folha é quem converte", () => {
  const result = day({ punches: [{ in: "20:00", out: "23:00" }], expectedMinutes: 180, justification: "Plantão" });
  // Uma hora dentro da janela; se aplicássemos a hora reduzida, seriam ~68 minutos.
  assert.equal(result.nightMinutes, 60);
});

test("data futura é bloqueante", () => {
  const result = calculateTimeDay({
    entryDate: "2026-09-01", dayType: "regular", expectedMinutes: 480, punches: [{ in: "08:00", out: "16:00" }],
  }, { today: "2026-07-31" });
  assert.ok(result.issues.some((issue) => issue.kind === "future_date" && issue.severity === "blocking"));
});

test("jornada prevista ausente em dia útil impede a apuração do saldo", () => {
  const result = day({ expectedMinutes: null });
  assert.ok(result.issues.some((issue) => issue.kind === "missing_schedule" && issue.severity === "blocking"));
});

test("intervalo curto em jornada longa é sinalizado como aviso", () => {
  const result = day({
    punches: [{ in: "08:00", out: "12:00" }, { in: "12:20", out: "16:20" }],
    expectedMinutes: 480, justification: "Acordo de intervalo",
  });
  assert.ok(result.issues.some((issue) => issue.kind === "interval_below_minimum" && issue.severity === "warning"));
});

test("marcações são reduzidas a entrada e saída; campos extras do relógio são descartados", () => {
  const punches = sanitizePunches([
    { in: "08:00", out: "12:00", employeeCpf: "12345678901", device: "REP-01" },
    "ignorado",
    { in: "13:00", out: "17:00" },
  ]);
  assert.deepEqual(punches, [{ in: "08:00", out: "12:00" }, { in: "13:00", out: "17:00" }]);
  assert.throws(() => sanitizePunches([{ in: "25:00", out: "26:00" }]), (error: { code?: string }) => error.code === "INVALID_CLOCK");
});

/* -------------------------------------------------------------------------- */
/* Consolidação e aprovação                                                    */
/* -------------------------------------------------------------------------- */

test("a folha soma os dias e separa bloqueio de aviso", () => {
  const totals = calculateTimeSheet({
    days: [
      { entryDate: "2026-07-06", dayType: "regular", expectedMinutes: 480, punches: [{ in: "08:00", out: "12:00" }, { in: "13:00", out: "18:00" }], justification: "Demanda de fechamento" },
      { entryDate: "2026-07-07", dayType: "regular", expectedMinutes: 480, punches: [] },
      { entryDate: "2026-07-08", dayType: "regular", expectedMinutes: 480, punches: [{ in: "08:00", out: "12:00" }, { in: "13:00", out: "17:00" }] },
    ],
    rules: { today: "2026-07-31" },
  });
  assert.equal(totals.entriesCount, 3);
  assert.equal(totals.workedMinutes, 540 + 0 + 480);
  assert.equal(totals.expectedMinutes, 1440);
  assert.equal(totals.balanceMinutes, -420);
  assert.equal(totals.blockingIssues, 1);
  assert.equal(totals.calcVersion, TIME_CALC_VERSION);
  const overtime = totals.events.find((event) => event.eventCode === "overtime_50");
  assert.equal(overtime?.minutes, 60);
  assert.equal(overtime?.source, "computed");
});

test("evento manual exige justificativa e é marcado como manual", () => {
  assert.throws(
    () => calculateTimeSheet({ days: [], manualEvents: [{ eventCode: "on_call_hours", minutes: 120, justification: "ok" }] }),
    (error: { code?: string }) => error.code === "TIME_EVENT_JUSTIFICATION_REQUIRED",
  );
  const totals = calculateTimeSheet({
    days: [],
    manualEvents: [{ eventCode: "on_call_hours", minutes: 120, justification: "Sobreaviso acordado em escala" }],
  });
  assert.deepEqual(totals.events, [{ eventCode: "on_call_hours", minutes: 120, source: "manual" }]);
});

test("inconsistência bloqueante em aberto impede a aprovação", () => {
  assert.throws(() => assertApprovable(2), (error: { code?: string; message?: string }) =>
    error.code === "TIME_BLOCKING_INCONSISTENCIES" && /2 inconsistência/u.test(String(error.message)));
  assert.doesNotThrow(() => assertApprovable(0));
});

test("não existe caminho da conferência direto para exportado", () => {
  assert.deepEqual(timeSheetTransitions.review, ["approved", "rejected", "draft"]);
  assert.throws(() => assertTimeTransition("review", "exported"), (error: { code?: string }) => error.code === "INVALID_TIME_TRANSITION");
  assert.equal(assertTimeTransition("approved", "exported"), "exported");
  // Voltar de exportado é reabertura, e a rota exige justificativa.
  assert.equal(assertTimeTransition("exported", "review"), "review");
});

test("folha exportada ou fechada não aceita edição sem reabertura", () => {
  for (const status of ["exported", "closed"]) {
    assert.throws(() => assertTimeSheetMutable(status), (error: { code?: string }) => error.code === "TIME_SHEET_LOCKED");
  }
  for (const status of ["draft", "review", "approved", "rejected"]) {
    assert.doesNotThrow(() => assertTimeSheetMutable(status));
  }
});

test("a entrada da tela e a da importação passam pela mesma validação", () => {
  const parsed = parseTimeEntryPayload({
    date: "2026-07-06", dayType: "regular", expectedMinutes: 480,
    punches: [{ in: "08:00", out: "12:00" }], justification: "  ok  ", origin: "import",
  });
  assert.equal(parsed.entryDate, "2026-07-06");
  assert.equal(parsed.origin, "import");
  assert.equal(parsed.justification, "ok");
  assert.throws(() => parseTimeEntryPayload({ date: "06/07/2026" }), (error: { code?: string }) => error.code === "INVALID_DATE");
  assert.throws(() => parseTimeEntryPayload({ date: "2026-07-06", dayType: "sabado" }), (error: { code?: string }) => error.code === "INVALID_TIME_DAY_TYPE");
  assert.throws(() => parseTimeEntryPayload({ date: "2026-07-06", expectedMinutes: 5000 }), (error: { code?: string }) => error.code === "INVALID_EXPECTED_MINUTES");
});

test("a prévia da exportação acusa o bloqueio antes de qualquer gravação", () => {
  const preview = previewTimeExport({
    destination: "folha",
    sheets: [
      { sheetId: "s1", employeeId: "e1", registrationNumber: "0001", employeeName: "Ana", events: [{ eventCode: "overtime_50", minutes: 60 }] },
      { sheetId: "s2", employeeId: "e2", registrationNumber: "0002", employeeName: "Bruno", events: [{ eventCode: "night_hours", minutes: 30 }] },
    ],
    mappings: [{ eventCode: "overtime_50", rubricCode: "0910", targetField: "quantity", unit: "hours_decimal", destination: "folha" }],
  });
  assert.equal(preview.ready, false);
  assert.deepEqual(preview.missingMappings, ["night_hours"]);
  assert.equal(preview.linesCount, 1);
});

test("duração é apresentada em HH:MM com sinal", () => {
  assert.equal(formatDuration(90), "01:30");
  assert.equal(formatDuration(-90), "-01:30");
  assert.equal(formatDuration(1500), "25:00");
});

/* -------------------------------------------------------------------------- */
/* Permissões, esquema e integração com o produto                              */
/* -------------------------------------------------------------------------- */

test("as capabilities de ponto seguem o papel do usuário", () => {
  assert.equal(hasCapability("admin", "time.mappings.manage"), true);
  assert.equal(hasCapability("member", "time.approve"), true);
  // Configurar a rubrica de destino é ato de configuração, restrito ao administrador.
  assert.equal(hasCapability("member", "time.mappings.manage"), false);
  assert.equal(hasCapability("observer", "time.read"), true);
  assert.equal(hasCapability("observer", "time.manage"), false);
  assert.equal(hasCapability("guest", "time.read"), false);
});

test("o banco repete a proibição do §22 e congela a folha exportada", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0021_time_tracking.sql", import.meta.url), "utf8");
  assert.match(migration, /"target_field" IN \('quantity', 'reference', 'index'\)/);
  assert.doesNotMatch(migration, /'value'|'valor'/);
  // Isolamento multi-tenant em todas as tabelas novas.
  for (const table of ["fdp_hour_event_mappings", "fdp_time_sheets", "fdp_time_entries", "fdp_time_sheet_events", "fdp_time_inconsistencies", "fdp_time_exports"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`));
  }
  assert.match(migration, /exported time sheet is immutable/);
  assert.match(migration, /reopening an exported time sheet requires a justification/);
  assert.match(migration, /time export batches are append-only/);
  // Saldo é derivado no banco: não existe caminho para gravar saldo inventado.
  assert.match(migration, /"balance_minutes" = "fdp_time_sheets"\."worked_minutes" - "fdp_time_sheets"\."expected_minutes"/);
});

test("a central de ação passa a cobrir o ponto com consultas reais", () => {
  const keys = actionDefinitions.map((definition) => definition.key);
  for (const key of ["time_blocking_inconsistencies", "time_sheets_pending", "time_export_blocked"]) {
    assert.ok(keys.includes(key), `${key} deveria existir na central de ação`);
    const definition = actionDefinitions.find((item) => item.key === key)!;
    assert.equal(definition.capability, "time.read");
    assert.equal(definition.target, "timeTracking");
    assert.match(definition.sql, /FROM fdp_time_/);
  }
  const blocked = actionDefinitions.find((item) => item.key === "time_export_blocked")!;
  assert.match(blocked.sql, /NOT EXISTS/);
  assert.match(blocked.sql, /fdp_hour_event_mappings/);
});

test("a rota de exportação exige capability própria e não aceita exportar pela transição", async () => {
  const [exportRoute, transitionRoute] = await Promise.all([
    readFile(new URL("../app/api/time/export/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/time/sheets/[id]/transition/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(exportRoute, /requireCapability\(workspace, "time\.export"\)/);
  assert.match(exportRoute, /runTimeExport/);
  assert.match(transitionRoute, /TIME_EXPORT_ROUTE_REQUIRED/);
  assert.match(transitionRoute, /assertApprovable/);
  // Aprovar reapura antes de decidir.
  assert.match(transitionRoute, /recalculateTimeSheet\(d1, workspace\.id, id\)/);
});

test("a tela do ponto não oferece campo de valor no mapeamento", async () => {
  const dialogs = await readFile(new URL("../app/painel/features/time/TimeDialogs.tsx", import.meta.url), "utf8");
  const options = [...dialogs.matchAll(/<option value="(quantity|reference|index|value|amount)"/gu)].map((match) => match[1]);
  assert.deepEqual(options, ["quantity", "reference", "index"]);
});
