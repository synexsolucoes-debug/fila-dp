import assert from "node:assert/strict";
import test from "node:test";
import {
  inss, irrf, monthlyPayroll, noticeDays, terminationPay, thirteenthAvos, thirteenthSalary,
  vacationAvos, vacationDaysByAbsences, vacationPay, currentVacationPeriodStart,
} from "../lib/payroll-calc.ts";
import { inssTables, irrfTables, tableAt } from "../lib/payroll-tables.ts";

/**
 * Cálculo de folha do ERP DP (docs/engenharia-reversa-sap-hcm.md §18).
 * Os valores esperados foram feitos à mão, faixa a faixa — se um destes
 * números mudar, a tabela ou a regra mudou, e isso precisa ser de propósito.
 */

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const line = (lines: { code: string; amount: number }[], id: string) => lines.find((item) => item.code === id)?.amount;

test("tabelas 2026 com a fonte de cada uma", () => {
  assert.match(tableAt(inssTables, "2026-05-01", "x").source, /Portaria Interministerial MPS\/MF nº 13\/2026/u);
  assert.match(tableAt(irrfTables, "2026-05-01", "x").source, /Lei 15\.270\/2025/u);
  // Sem tabela para a data, recusa em vez de chutar.
  assert.throws(() => inss(300_000, "2024-12-31"), code("INSS_TABLE_UNAVAILABLE"));
});

test("2025 tem as próprias tabelas: o cálculo de um mês passado usa a regra daquele mês", () => {
  // INSS 2025 (Portaria 6/2025): teto de R$ 8.157,41 → R$ 951,63.
  assert.equal(inss(1_000_000, "2025-06-01").amount, 95_163);
  // IRRF jan–abr/2025 (Lei 14.848/2024): isenção até R$ 2.259,20 de base.
  assert.equal(irrf({ gross: 300_000, inss: 0, dependents: 0, date: "2025-03-01", allowSimplified: false }).amount, Math.round(300_000 * 0.15 - 38_144));
  // A partir de maio/2025 (Lei 15.191/2025), sem a redução de 2026.
  const may = irrf({ gross: 500_000, inss: 50_000, dependents: 0, date: "2025-06-01" });
  assert.equal(may.reduction, 0);
  assert.ok(may.amount > 0);
});

test("INSS progressivo: cada alíquota só na sua fatia, com teto", () => {
  assert.equal(inss(162_100, "2026-03-01").amount, 12_158);
  assert.equal(inss(500_000, "2026-03-01").amount, 50_151);
  assert.equal(inss(800_000, "2026-03-01").amount, 92_151);
  const capped = inss(1_000_000, "2026-03-01");
  assert.equal(capped.amount, 98_809);
  assert.ok(capped.capped);
});

test("IRRF: escolhe o melhor entre deduções legais e simplificado, e aplica a redução pelo bruto", () => {
  // Até R$ 5.000 a redução zera o imposto.
  const five = irrf({ gross: 500_000, inss: 50_151, dependents: 0, date: "2026-03-01" });
  assert.equal(five.method, "simplified");
  assert.equal(five.beforeReduction, 31_289);
  assert.equal(five.amount, 0);
  // Entre R$ 5.000 e R$ 7.350: 978,62 − 0,133145 × 6.000 = 179,75 de redução.
  const six = irrf({ gross: 600_000, inss: 64_151, dependents: 0, date: "2026-03-01" });
  assert.equal(six.method, "legal");
  assert.equal(six.beforeReduction, 56_485);
  assert.equal(six.reduction, 17_975);
  assert.equal(six.amount, 38_510);
  // Acima de R$ 7.350, sem redução.
  const eight = irrf({ gross: 800_000, inss: 92_151, dependents: 0, date: "2026-03-01" });
  assert.equal(eight.reduction, 0);
  assert.equal(eight.amount, 103_785);
  // Dependente reduz a base legal.
  const withDependents = irrf({ gross: 800_000, inss: 92_151, dependents: 2, date: "2026-03-01" });
  assert.equal(withDependents.base, 800_000 - 92_151 - 2 * 18_959);
});

test("avos de 13º: mês com 15 dias ou mais conta", () => {
  assert.equal(thirteenthAvos("2026-03-20", "2026-12-31"), 9);
  assert.equal(thirteenthAvos("2026-03-17", "2026-12-31"), 10);
  assert.equal(thirteenthAvos("2020-01-01", "2026-04-23"), 4);
  assert.equal(thirteenthAvos("2020-01-01", "2026-04-14"), 3);
});

test("avos de férias: mês cheio do período aquisitivo e fração acima de 14 dias", () => {
  assert.equal(vacationAvos("2025-03-10", "2025-09-20"), 6);
  assert.equal(vacationAvos("2025-03-10", "2025-09-24"), 7);
  assert.equal(vacationAvos("2025-03-10", "2026-03-09"), 12);
  assert.equal(currentVacationPeriodStart("2020-03-10", "2026-04-23"), "2026-03-10");
  assert.equal(currentVacationPeriodStart("2020-03-10", "2026-03-09"), "2025-03-10");
  assert.deepEqual([0, 5, 6, 14, 15, 23, 24, 32, 33].map(vacationDaysByAbsences), [30, 30, 24, 24, 18, 18, 12, 12, 0]);
  assert.equal(noticeDays("2020-03-10", "2026-03-09"), 45);
});

test("folha mensal: horas extras, DSR, faltas, INSS e IRRF", () => {
  const result = monthlyPayroll({
    competence: "2026-03", salary: 440_000, monthlyHours: 220, dependents: 0,
    overtime50Hours: 10, workingDays: 25, restDays: 6, absenceDays: 1,
  });
  // Hora = 4.400 / 220 = 20; HE 50% = 10 × 30 = 300; DSR = 300 / 25 × 6 = 72.
  assert.equal(line(result.lines, "1010"), 30_000);
  assert.equal(line(result.lines, "1020"), 7_200);
  assert.equal(line(result.lines, "5010"), 14_667);
  const base = 440_000 + 30_000 + 7_200 - 14_667;
  assert.equal(line(result.lines, "9000"), base);
  assert.equal(line(result.lines, "5000"), inss(base, "2026-03-01").amount);
  assert.equal(result.net, result.earnings - result.deductions);
  assert.equal(result.fgts, Math.round(base * 0.08));
});

test("férias com abono: abono sem INSS/IRRF, e no máximo 1/3", () => {
  const result = vacationPay({ start: "2026-07-01", salary: 300_000, entitledDays: 30, soldDays: 10, dependents: 0 });
  assert.equal(line(result.lines, "2000"), 200_000);
  assert.equal(line(result.lines, "2001"), 66_667);
  assert.equal(line(result.lines, "2010"), 100_000);
  assert.equal(line(result.lines, "2011"), 33_333);
  assert.equal(line(result.lines, "5000"), inss(266_667, "2026-07-01").amount);
  assert.throws(() => vacationPay({ start: "2026-07-01", salary: 300_000, entitledDays: 30, soldDays: 11, dependents: 0 }), code("VACATION_SALE_TOO_LONG"));
});

test("13º: avos do ano, INSS e IRRF próprios, sem desconto simplificado", () => {
  const result = thirteenthSalary({ year: 2026, admissionDate: "2026-03-20", salary: 1_200_000, dependents: 0 });
  assert.equal(line(result.lines, "3000"), 900_000);
  const contribution = inss(900_000, "2026-12-20").amount;
  assert.equal(line(result.lines, "5000"), contribution);
  assert.equal(line(result.lines, "5001"), irrf({ gross: 900_000, inss: contribution, dependents: 0, date: "2026-12-20", allowSimplified: false }).amount);
});

test("rescisão sem justa causa: aviso proporcional projetado, 13º e férias, multa de 40%", () => {
  const result = terminationPay({
    kind: "without_cause", admissionDate: "2020-03-10", terminationDate: "2026-03-09",
    salary: 300_000, dependents: 0, fgtsBalance: 1_000_000,
  });
  assert.equal(result.noticeDays, 45);
  assert.equal(result.projectedEnd, "2026-04-23");
  assert.equal(line(result.lines, "4000"), 90_000);
  assert.equal(line(result.lines, "4010"), 450_000);
  assert.equal(line(result.lines, "4030"), 100_000);
  assert.equal(line(result.lines, "4050"), 25_000);
  assert.equal(line(result.lines, "4051"), 8_333);
  assert.equal(line(result.lines, "5000"), 6_750);
  assert.equal(line(result.lines, "5002"), 7_500);
  assert.equal(result.earnings, 673_333);
  assert.equal(result.net, 673_333 - 14_250);
  // FGTS do mês sobre saldo, aviso e 13º; multa sobre saldo + depósito do mês.
  assert.equal(line(result.lines, "9011"), 51_200);
  assert.equal(line(result.lines, "9010"), 420_480);
});

test("justa causa: só saldo de salário e férias vencidas", () => {
  const result = terminationPay({
    kind: "just_cause", admissionDate: "2020-03-10", terminationDate: "2026-03-09",
    salary: 300_000, dependents: 0, overdueVacationPeriods: 1,
  });
  const codes = result.lines.filter((item) => item.kind === "earning").map((item) => item.code);
  assert.deepEqual(codes, ["4000", "4040", "4041"]);
  assert.ok(!result.lines.some((item) => item.code === "9010"));
});

test("acordo: metade do aviso e multa de 20%; pedido de demissão pode descontar o aviso", () => {
  const agreement = terminationPay({
    kind: "agreement", admissionDate: "2020-03-10", terminationDate: "2026-03-09",
    salary: 300_000, dependents: 0, fgtsBalance: 1_000_000,
  });
  assert.equal(agreement.noticeDays, 22);
  assert.match(agreement.lines.find((item) => item.code === "9010")?.label ?? "", /20%/u);
  const resignation = terminationPay({
    kind: "resignation", admissionDate: "2020-03-10", terminationDate: "2026-03-09",
    salary: 300_000, dependents: 0, discountUnworkedNotice: true,
  });
  assert.equal(line(resignation.lines, "5040"), 300_000);
  assert.ok(!resignation.lines.some((item) => item.code === "4010"));
});

test("rescisão antecipada do contrato a prazo: metade dos dias que faltavam (art. 479)", () => {
  const result = terminationPay({
    kind: "fixed_term_early", admissionDate: "2026-01-01", terminationDate: "2026-02-14",
    contractEnd: "2026-03-31", salary: 300_000, dependents: 0,
  });
  // 15/02 a 31/03 = 45 dias; metade = 22,5 dias × R$ 100.
  assert.equal(line(result.lines, "4020"), 225_000);
  assert.throws(() => terminationPay({
    kind: "fixed_term_early", admissionDate: "2026-01-01", terminationDate: "2026-02-14", salary: 300_000, dependents: 0,
  }), code("CONTRACT_END_REQUIRED"));
});

test("saldo de salário: mês inteiro vale 30 dias, mesmo em fevereiro", () => {
  const february = terminationPay({ kind: "resignation", admissionDate: "2020-01-01", terminationDate: "2026-02-28", salary: 300_000, dependents: 0 });
  assert.equal(line(february.lines, "4000"), 300_000);
  const partial = terminationPay({ kind: "resignation", admissionDate: "2020-01-01", terminationDate: "2026-02-27", salary: 300_000, dependents: 0 });
  assert.equal(line(partial.lines, "4000"), 270_000);
});
