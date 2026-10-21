import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inss, monthlyPayroll, terminationPay, thirteenthSalary, vacationPay } from "../lib/payroll-calc.ts";
import { employeePayroll, payrollCategoryOf, type RunEmployee } from "../lib/payroll-run.ts";
import { defaultSettings, employerCharges, obligationsSummary, type ResultForObligations } from "../lib/payroll-obligations.ts";
import type { Remuneration } from "../lib/remuneration.ts";

/**
 * Regras que faltavam no cálculo do ERP DP (§4.41 de
 * docs/arquitetura-operacional.md): estagiário, aprendiz, pró-labore,
 * salário-família, pensão por percentual, banco de horas e piso salarial.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const line = (lines: { code: string; amount: number }[], id: string) => lines.find((item) => item.code === id)?.amount;
const month = (overrides: Parameters<typeof monthlyPayroll>[0] extends infer T ? Partial<T> : never = {}) =>
  monthlyPayroll({ competence: "2026-03", salary: 300_000, monthlyHours: 220, dependents: 0, ...overrides });

test("estagiário: bolsa sem INSS e sem FGTS, com IRRF", () => {
  const result = month({ category: "intern", salary: 600_000 });
  assert.equal(result.lines[0].label, "Bolsa-estágio");
  assert.equal(line(result.lines, "5000"), undefined);
  assert.equal(result.fgts, 0);
  assert.ok((line(result.lines, "5001") ?? 0) > 0);
  assert.equal(line(result.lines, "9000"), 0);
});

test("aprendiz: FGTS de 2%", () => {
  const result = month({ category: "apprentice", salary: 162_100 });
  assert.equal(result.fgts, Math.round(162_100 * 0.02));
  assert.ok(result.notes.some((note) => /Lei 10\.097/u.test(note)));
});

test("pró-labore: INSS de 11% até o teto, sem FGTS, base patronal só dos 20%", () => {
  const result = month({ category: "pro_labore", salary: 1_000_000 });
  assert.equal(result.lines[0].label, "Pró-labore");
  assert.equal(line(result.lines, "5000"), Math.round(847_555 * 0.11));
  assert.equal(result.fgts, 0);
  assert.equal(line(result.lines, "9000"), 0);
  assert.equal(line(result.lines, "9002"), 1_000_000);
  const partner: ResultForObligations = { employeeId: "s", name: "Sócia", registrationNumber: "S1", netCents: result.net, earningsCents: result.earnings,
    deductionsCents: result.deductions, fgtsCents: 0, lines: result.lines };
  const charges = employerCharges([partner], defaultSettings);
  assert.equal(charges.cpp, 200_000);
  assert.equal(charges.rat, 0);
  assert.equal(charges.thirdParties, 0);
});

test("salário-família: cota por filho até o limite, proporcional na admissão, compensado na guia", () => {
  const result = month({ salary: 180_000, familyChildren: 2 });
  assert.equal(line(result.lines, "1060"), 13_508);
  // Não entra nas bases.
  assert.equal(line(result.lines, "9000"), 180_000);
  const above = month({ salary: 250_000, familyChildren: 2 });
  assert.equal(line(above.lines, "1060"), undefined);
  assert.ok(above.notes.some((note) => /não devido/u.test(note)));
  const admitted = month({ salary: 180_000, familyChildren: 2, workedDays: 15 });
  assert.equal(line(admitted.lines, "1060"), 6_754);
  assert.equal(month({ salary: 180_000, familyChildren: 2, category: "intern" }).lines.some((item) => item.code === "1060"), false);
  const holder: ResultForObligations = { employeeId: "f", name: "F", registrationNumber: "F1", netCents: result.net, earningsCents: result.earnings,
    deductionsCents: result.deductions, fgtsCents: result.fgts, lines: result.lines };
  const summary = obligationsSummary("2026-03", [holder], defaultSettings);
  const cp = summary.guides.find((guide) => guide.code === "cp")!;
  assert.equal(cp.amountCents, (line(result.lines, "5000") ?? 0) + summary.charges.total - 13_508);
  assert.match(cp.detail, /salário-família/u);
});

test("pensão por percentual: sobre o bruto menos INSS ou sobre o bruto, e deduz do IRRF", () => {
  const contribution = inss(600_000, "2026-03-01").amount;
  const net = month({ salary: 600_000, alimonyPercent: 30, alimonyBase: "gross_minus_inss" });
  assert.equal(line(net.lines, "5020"), Math.round((600_000 - contribution) * 0.3));
  const gross = month({ salary: 600_000, alimonyPercent: 30, alimonyBase: "gross" });
  assert.equal(line(gross.lines, "5020"), 180_000);
  assert.ok((line(net.lines, "5001") ?? 0) < (line(month({ salary: 600_000 }).lines, "5001") ?? 0));
});

test("estagiário e pró-labore não têm férias, 13º nem rescisão da CLT; aprendiz tem FGTS de 2% neles", () => {
  assert.throws(() => vacationPay({ start: "2026-07-01", salary: 300_000, entitledDays: 30, dependents: 0, category: "intern" }), code("CATEGORY_NOT_CLT"));
  assert.throws(() => thirteenthSalary({ year: 2026, admissionDate: "2020-01-01", salary: 300_000, dependents: 0, category: "pro_labore" }), code("CATEGORY_NOT_CLT"));
  const apprentice = terminationPay({ kind: "fixed_term_end", admissionDate: "2024-03-01", terminationDate: "2026-02-28", salary: 162_100, dependents: 0, category: "apprentice" });
  assert.equal(apprentice.lines.find((item) => item.code === "9011")?.reference, "2%");
  assert.equal(thirteenthSalary({ year: 2026, admissionDate: "2020-01-01", salary: 162_100, dependents: 0, category: "apprentice" }).fgts, Math.round(162_100 * 0.02));
});

test("categoria vem do cadastro e da remuneração; banco de horas e piso aparecem na folha", () => {
  assert.equal(payrollCategoryOf("intern", { proLabore: false }), "intern");
  assert.equal(payrollCategoryOf("clt", { proLabore: true }), "pro_labore");
  assert.equal(payrollCategoryOf(undefined, { proLabore: false }), "employee");
  const employee: RunEmployee = { id: "e", fullName: "E", registrationNumber: "1", admissionDate: "2020-01-01", terminationDate: null, employmentStatus: "active", employmentType: "clt" };
  const remuneration: Remuneration = {
    id: "r", validFrom: "2020-01-01", validTo: "9999-12-31", salaryKind: "monthly", amountCents: 150_000, monthlyHours: 220, irrfDependents: 0,
    unhealthyPercent: 0, hazardous: false, transportVoucherCents: 0, mealVoucherDiscountCents: 0, proLabore: false, familyAllowanceChildren: 0,
    alimonyPercent: 0, alimonyBase: "gross_minus_inss", reason: "admission", notes: "",
  };
  const payroll = employeePayroll({
    competence: "2026-03", employee, remuneration, installments: [], retroactive: [], salaryFloorCents: 180_000,
    time: { sheetId: "s", status: "approved", events: { time_bank_credit: 150, time_bank_debit: 30 } },
  });
  assert.equal(payroll.result.lines.find((item) => item.code === "9020")?.reference, "+2h00");
  assert.ok(payroll.result.notes.some((note) => /abaixo do piso/u.test(note)));
});

test("migration das regras e a configuração do piso", async () => {
  const migration = await read("drizzle/postgres/0118_erp_dp_payroll_rules.sql");
  assert.match(migration, /"pro_labore" boolean DEFAULT false NOT NULL/u);
  assert.match(migration, /"alimony_percent" BETWEEN 0 AND 100/u);
  assert.match(migration, /"salary_floor_cents" bigint DEFAULT 0 NOT NULL/u);
  const tables = await read("lib/payroll-tables.ts");
  assert.match(tables, /quota: 6_754, limit: 198_038/u);
});
