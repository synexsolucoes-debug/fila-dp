import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  accountingCsv, accountingEntries, defaultSettings, dueDay20, employerCharges, obligationsSummary, previousBusinessDay,
  s1200Csv, salaryDueDate, toCsv, type ResultForObligations,
} from "../lib/payroll-obligations.ts";
import { cnab240Salaries } from "../lib/cnab240.ts";
import { monthlyPayroll } from "../lib/payroll-calc.ts";
import { parseBankAccount, parseSettings } from "../lib/payroll-settings-service.ts";

/**
 * Obrigações e pagamento da folha do ERP DP (§4.35 de
 * docs/arquitetura-operacional.md): encargos, guias com vencimento, CNAB 240,
 * rubricas do S-1200 e contabilização.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const result = (registrationNumber: string, salary: number): ResultForObligations => {
  const payroll = monthlyPayroll({ competence: "2026-03", salary, monthlyHours: 220, dependents: 0, overtime50Hours: 10, workingDays: 26, restDays: 5 });
  return { employeeId: registrationNumber, name: `Pessoa ${registrationNumber}`, registrationNumber, netCents: payroll.net, earningsCents: payroll.earnings,
    deductionsCents: payroll.deductions, fgtsCents: payroll.fgts, lines: payroll.lines };
};
const results = [result("001", 300_000), result("002", 800_000)];

test("vencimentos: dia 20 antecipado no fim de semana, salário no 5º dia útil com sábado", () => {
  // 20/04/2026 é segunda; 20/06/2026 é sábado → 19/06.
  assert.equal(dueDay20("2026-03"), "2026-04-20");
  assert.equal(dueDay20("2026-05"), "2026-06-19");
  assert.equal(previousBusinessDay("2026-06-21"), "2026-06-19");
  // Abril/2026: 1 (qua), 2, 3, 4 (sáb conta), 6 (seg) — domingo 5 não conta.
  assert.equal(salaryDueDate("2026-03"), "2026-04-06");
});

test("encargos do empregador: 20% + RAT × FAP + terceiros sobre a base de INSS; Simples fica no DAS", () => {
  const base = results.reduce((acc, item) => acc + (item.lines.find((line) => line.code === "9000")?.amount ?? 0), 0);
  const standard = employerCharges(results, { ...defaultSettings, ratPercent: 3, fap: 1.5, thirdPartiesPercent: 5.8 });
  assert.equal(standard.base, base);
  assert.equal(standard.cpp, Math.round(base * 0.2));
  assert.equal(standard.rat, Math.round(base * 0.03 * 1.5));
  assert.equal(standard.thirdParties, Math.round(base * 0.058));
  assert.equal(standard.total, standard.cpp + standard.rat + standard.thirdParties);
  const simples = employerCharges(results, { ...defaultSettings, employerContribution: "simples_exempt" });
  assert.equal(simples.total, 0);
  assert.match(simples.note, /DAS/u);
});

test("resumo das guias soma o que cada uma recolhe", () => {
  const summary = obligationsSummary("2026-03", results, defaultSettings);
  const byCode = Object.fromEntries(summary.guides.map((guide) => [guide.code, guide]));
  assert.equal(byCode.salaries.amountCents, results[0].netCents + results[1].netCents);
  assert.equal(byCode.fgts.amountCents, results[0].fgtsCents + results[1].fgtsCents);
  const inss = results.reduce((acc, item) => acc + (item.lines.find((line) => line.code === "5000")?.amount ?? 0), 0);
  assert.equal(byCode.cp.amountCents, inss + summary.charges.total);
  assert.equal(byCode.irrf.amountCents, results.reduce((acc, item) => acc + (item.lines.find((line) => line.code === "5001")?.amount ?? 0), 0));
  assert.equal(byCode.fgts.dueDate, "2026-04-20");
});

test("CNAB 240: cinco tipos de registro, 240 posições cada, totais no trailer", () => {
  const file = cnab240Salaries({
    company: { name: "Empresa Ensaio Ltda", taxId: "12.345.678/0001-90", bank: { code: "341", agency: "1234", agencyDigit: "", account: "56789", accountDigit: "0", agreement: "CONV123" } },
    payments: [
      { name: "José Ação", bankCode: "001", agency: "4321", agencyDigit: "5", account: "98765", accountDigit: "X", amountCents: 251_050, reference: "2026-03-001" },
      { name: "Maria", bankCode: "237", agency: "1", agencyDigit: "", account: "1", accountDigit: "1", amountCents: 100_000, reference: "2026-03-002" },
    ],
    paymentDate: "2026-04-06", generatedAt: new Date("2026-04-02T10:20:30Z"), sequence: 7,
  });
  const lines = file.content.split("\r\n").slice(0, -1);
  assert.equal(lines.length, 6);
  for (const line of lines) assert.equal(line.length, 240, line);
  assert.deepEqual(lines.map((line) => line[7]), ["0", "1", "3", "3", "5", "9"]);
  assert.equal(lines[0].slice(0, 3), "341");
  assert.equal(lines[0].slice(18, 32), "12345678000190");
  // Serviço 30 (salários), forma 01 (crédito em conta).
  assert.equal(lines[1].slice(9, 13), "3001");
  assert.equal(lines[2][13], "A");
  assert.match(lines[2], /JOSE ACAO/u);
  assert.equal(lines[2].slice(93, 101), "06042026");
  assert.equal(lines[2].slice(119, 134), "000000000251050");
  assert.equal(lines[4].slice(17, 23), "000004");
  assert.equal(lines[4].slice(23, 41), "000000000000351050");
  assert.equal(lines[5].slice(23, 29), "000006");
  assert.ok(/^[\x20-\x7e\r\n]+$/u.test(file.content));
  assert.throws(() => cnab240Salaries({ company: { name: "x", taxId: "1", bank: { code: "1", agency: "1", agencyDigit: "", account: "1", accountDigit: "", agreement: "" } },
    payments: [], paymentDate: "2026-04-06", generatedAt: new Date(), sequence: 1 }), code("CNAB_EMPTY"));
});

test("rubricas no formato do S-1200 e lançamentos contábeis em CSV", () => {
  const csv = s1200Csv("2026-03", results);
  assert.ok(csv.startsWith("\uFEFFperApur;matricula;nome;codRubr;ideTabRubr;dscRubr;natureza;qtdRubr;vrRubr"));
  assert.match(csv, /2026-03;001;Pessoa 001;1010;VINC;Horas extras 50%;provento;10;/u);
  assert.doesNotMatch(csv, /;9000;/u);
  const entries = accountingEntries("2026-03", results, defaultSettings);
  assert.equal(entries[0].date, "2026-03-31");
  // Débitos de salários a pagar fecham com os descontos.
  const deductions = results.reduce((acc, item) => acc + item.deductionsCents, 0);
  const fromPayable = entries.filter((entry) => entry.debit.includes("Salários a pagar")).reduce((acc, entry) => acc + entry.amountCents, 0);
  assert.equal(fromPayable, deductions);
  assert.match(accountingCsv(entries), /3\.1\.1\.01 Salários e ordenados;2\.1\.3\.01 Salários a pagar;/u);
  assert.equal(toCsv([["a;b", "c\"d"]]), '\uFEFF"a;b";"c""d"\r\n');
});

test("configuração e conta bancária validadas", () => {
  assert.throws(() => parseSettings({ ratPercent: 4 }), code("SETTINGS_RAT_INVALID"));
  assert.throws(() => parseSettings({ fap: "2,5" }), code("SETTINGS_FAP_INVALID"));
  assert.equal(parseSettings({ fap: "1,25", bank: { code: "1", agency: "12" } }).bank?.code, "001");
  assert.throws(() => parseBankAccount({ bankCode: "341", agency: "12a", account: "1" }), code("BANK_FIELD_INVALID"));
  assert.throws(() => parseBankAccount({ bankCode: "341" }), code("BANK_ACCOUNT_REQUIRED"));
  assert.equal(parseBankAccount({ bankCode: "1", agency: "12", account: "34", accountDigit: "x" }).accountDigit, "X");
});

test("arquivos só de folha fechada, com permissão de gestão e auditoria", async () => {
  const exports = await read("app/api/erp-dp/payroll-runs/[id]/exports/route.ts");
  assert.match(exports, /requireCapability\(workspace, "payroll\.manage"\)/u);
  assert.match(exports, /PAYROLL_RUN_NOT_CLOSED/u);
  assert.match(exports, /payroll\.export\.\$\{kind\}/u);
  const obligations = await read("app/api/erp-dp/payroll-runs/[id]/obligations/route.ts");
  assert.match(obligations, /requireCapability\(workspace, "payroll\.read"\)/u);
  assert.match(await read("lib/payroll-exports-service.ts"), /requireCompanyAccess\(/u);
  const migration = await read("drizzle/postgres/0114_erp_dp_obligations.sql");
  for (const table of ["fdp_company_payroll_settings", "fdp_employee_bank_accounts"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"));
  }
  for (const path of ["app/api/erp-dp/payroll-settings/route.ts", "app/api/employees/[id]/bank-account/route.ts"]) {
    const source = await read(path);
    assert.match(source, /requireCapability\(workspace, "payroll\.manage"\)/u);
    assert.match(source, /prepareAuditEvent\(/u);
  }
});
