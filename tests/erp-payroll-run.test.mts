import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { eligibility, employeePayroll, monthCalendar, runTotals, type RunEmployee } from "../lib/payroll-run.ts";
import { inss, monthlyPayroll, variableAverage } from "../lib/payroll-calc.ts";
import type { Remuneration } from "../lib/remuneration.ts";

/**
 * Folha da competência do ERP DP (§4.32 de docs/arquitetura-operacional.md):
 * as entradas que vêm dos outros módulos, quem entra e quem fica de fora, a
 * diferença de retroativo e a média de variáveis.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const line = (lines: { code: string; amount: number }[], id: string) => lines.find((item) => item.code === id)?.amount;

const employee = (overrides: Partial<RunEmployee> = {}): RunEmployee => ({
  id: "e1", fullName: "Ana", registrationNumber: "001", admissionDate: "2020-01-10", terminationDate: null, employmentStatus: "active", ...overrides,
});
const remuneration = (overrides: Partial<Remuneration> = {}): Remuneration => ({
  id: "r1", validFrom: "2020-01-10", validTo: "9999-12-31", salaryKind: "monthly", amountCents: 440_000, monthlyHours: 220,
  irrfDependents: 0, unhealthyPercent: 0, hazardous: false, transportVoucherCents: 0, mealVoucherDiscountCents: 0,
  reason: "admission", notes: "", ...overrides,
});

test("calendário do DSR: domingos do mês como descanso", () => {
  // Março de 2026: 31 dias, 5 domingos (1, 8, 15, 22, 29).
  assert.deepEqual(monthCalendar("2026-03"), { days: 31, workingDays: 26, restDays: 5 });
  assert.deepEqual(monthCalendar("2026-02"), { days: 28, workingDays: 24, restDays: 4 });
});

test("quem fica de fora da folha, com o motivo", () => {
  assert.equal(eligibility(employee(), "2026-03", remuneration()), null);
  assert.match(eligibility(employee({ admissionDate: "2026-04-01" }), "2026-03", remuneration()) ?? "", /depois da competência/u);
  assert.match(eligibility(employee({ terminationDate: "2026-03-15" }), "2026-03", remuneration()) ?? "", /rescisão/u);
  assert.match(eligibility(employee({ employmentStatus: "on_leave" }), "2026-03", remuneration()) ?? "", /Afastado/u);
  assert.match(eligibility(employee(), "2026-03", null) ?? "", /Sem remuneração/u);
});

test("ponto aprovado entra: horas extras, DSR, adicional noturno e faltas em horas", () => {
  const payroll = employeePayroll({
    competence: "2026-03", employee: employee(), remuneration: remuneration(),
    time: { sheetId: "s1", status: "approved", events: { overtime_50: 600, night_hours: 105, absence_hours: 60, late_hours: 30 } },
    installments: [], retroactive: [],
  });
  const lines = payroll.result.lines;
  // Hora = 4.400 / 220 = R$ 20. 10 h a 50% = R$ 300. DSR = 300 / 26 × 5.
  assert.equal(line(lines, "1010"), 30_000);
  assert.equal(line(lines, "1020"), Math.round((30_000 / 26) * 5));
  // 105 min de relógio = 2 horas noturnas reduzidas; 20% de R$ 20 × 2 = R$ 8.
  assert.equal(line(lines, "1040"), 800);
  // 1h30 de faltas e atrasos = R$ 30.
  assert.equal(line(lines, "5011"), 3_000);
  assert.deepEqual(payroll.inputs.time, { sheetId: "s1", status: "approved", used: true });
});

test("ponto em rascunho não entra, e a folha avisa", () => {
  const payroll = employeePayroll({
    competence: "2026-03", employee: employee(), remuneration: remuneration(),
    time: { sheetId: "s1", status: "draft", events: { overtime_50: 600 } }, installments: [], retroactive: [],
  });
  assert.equal(line(payroll.result.lines, "1010"), undefined);
  assert.ok(payroll.result.notes.some((note) => /não foi aprovada/u.test(note)));
  assert.equal(payroll.inputs.time?.used, false);
});

test("parcelas de Adiantamentos e Descontos, VT até 6% e VR descontam sem mexer no INSS", () => {
  const payroll = employeePayroll({
    competence: "2026-03", employee: employee(), remuneration: remuneration({ transportVoucherCents: 40_000, mealVoucherDiscountCents: 5_000 }),
    time: null, installments: [{ id: "i1", entryId: "l1", label: "Empréstimo: notebook", amountCents: 25_000 }], retroactive: [],
  });
  const lines = payroll.result.lines;
  assert.equal(line(lines, "5060"), 25_000);
  // 6% de R$ 4.400 = R$ 264, menor que o custo de R$ 400.
  assert.equal(line(lines, "5050"), 26_400);
  assert.equal(line(lines, "5051"), 5_000);
  assert.equal(line(lines, "5000"), inss(440_000, "2026-03-01").amount);
  assert.deepEqual(payroll.inputs.installments, ["i1"]);
});

test("diferença retroativa entra como provento com incidências", () => {
  const payroll = employeePayroll({
    competence: "2026-04", employee: employee(), remuneration: remuneration(), time: null, installments: [],
    retroactive: [{ itemId: "x1", competence: "2026-02", amountCents: 20_000 }, { itemId: "x2", competence: "2026-01", amountCents: 0 }],
  });
  assert.equal(line(payroll.result.lines, "1095"), 20_000);
  assert.equal(line(payroll.result.lines, "9000"), 460_000);
  assert.deepEqual(payroll.inputs.retroactive, ["x1"]);
});

test("admitido no meio do mês recebe os dias do mês comercial", () => {
  const payroll = employeePayroll({
    competence: "2026-03", employee: employee({ admissionDate: "2026-03-16" }), remuneration: remuneration({ validFrom: "2026-03-16" }),
    time: null, installments: [], retroactive: [],
  });
  assert.equal(payroll.inputs.workedDays, 15);
  assert.equal(line(payroll.result.lines, "1000"), 220_000);
});

test("totais da folha somam as pessoas", () => {
  const a = { result: monthlyPayroll({ competence: "2026-03", salary: 300_000, monthlyHours: 220, dependents: 0 }) };
  const b = { result: monthlyPayroll({ competence: "2026-03", salary: 500_000, monthlyHours: 220, dependents: 0 }) };
  const totals = runTotals([a, b]);
  assert.equal(totals.net, a.result.net + b.result.net);
  assert.equal(totals.earnings, 800_000);
});

test("média de variáveis: folhas fechadas dos 12 meses anteriores", () => {
  const results = [
    { competence: "2025-02", lines: [{ code: "1010", label: "", kind: "earning" as const, amount: 99_999 }] },
    { competence: "2025-10", lines: [{ code: "1010", label: "", kind: "earning" as const, amount: 30_000 }, { code: "1000", label: "", kind: "earning" as const, amount: 440_000 }] },
    { competence: "2025-11", lines: [{ code: "1040", label: "", kind: "earning" as const, amount: 10_000 }] },
    { competence: "2026-03", lines: [{ code: "1010", label: "", kind: "earning" as const, amount: 50_000 }] },
  ];
  // Referência 03/2026: janela 03/2025 a 02/2026 — duas folhas, R$ 400 de variáveis.
  assert.deepEqual(variableAverage(results, "2026-03-10"), { amount: 20_000, months: 2 });
  assert.deepEqual(variableAverage([], "2026-03-10"), { amount: 0, months: 0 });
});

test("a folha nasce isolada por tenant, uma por competência, e fechada não muda", async () => {
  const migration = await read("drizzle/postgres/0112_erp_dp_payroll_runs.sql");
  for (const table of ["fdp_payroll_runs", "fdp_payroll_results"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"));
    assert.match(migration, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`, "u"));
  }
  assert.match(migration, /fdp_payroll_runs_cycle_uq/u);
  assert.match(migration, /"net_cents" = "earnings_cents" - "deductions_cents"/u);
  const service = await read("lib/payroll-run-service.ts");
  assert.match(service, /PAYROLL_RUN_CLOSED/u);
  assert.match(service, /PAYROLL_CYCLE_CLOSED/u);
  assert.match(service, /WHERE workspace_id = \? AND id = \? AND status = 'calculated'/u);
  assert.match(service, /payroll\.run\.closed/u);
  // Fechar marca os retroativos pagos como lançados nesta folha.
  assert.match(service, /UPDATE fdp_erp_retroactive_items SET status = 'posted'/u);
});

test("as rotas da folha exigem a permissão de salário e o escopo de empresa", async () => {
  const route = await read("app/api/erp-dp/payroll-runs/route.ts");
  const close = await read("app/api/erp-dp/payroll-runs/[id]/close/route.ts");
  assert.match(route, /requireCapability\(workspace, "payroll\.read"\)/u);
  assert.match(route, /requireCapability\(workspace, "payroll\.manage"\)/u);
  assert.match(route, /requireCompanyAccess\(/u);
  assert.match(close, /requireCapability\(workspace, "payroll\.manage"\)/u);
  assert.match(close, /requireCompanyAccess\(/u);
  const calc = await read("lib/erp-calculation-service.ts");
  assert.match(calc, /autoVariableAverage\(/u);
});
