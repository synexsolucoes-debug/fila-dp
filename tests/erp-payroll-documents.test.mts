import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatTaxId, payslipPdf, terminationPdf, vacationPdf, wrap } from "../lib/payroll-documents-pdf.ts";
import { monthlyPayroll, terminationPay, vacationPay } from "../lib/payroll-calc.ts";

/**
 * Documentos da folha do ERP DP (§4.33 de docs/arquitetura-operacional.md):
 * holerite, aviso e recibo de férias e demonstrativo rescisório com termo de
 * quitação, gerados do resultado calculado.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const company = { legalName: "Empresa Ensaio Ltda", taxId: "12345678000190", city: "Curitiba", state: "PR" };
const employee = { name: "Ana Folha", registrationNumber: "001", position: "Analista", department: "DP", admissionDate: "2020-03-10", cpfLast4: "1234" };
const text = (pdf: Uint8Array) => Buffer.from(pdf).toString("latin1");
const pages = (pdf: Uint8Array) => (text(pdf).match(/\/Type \/Page /gu) ?? []).length;

test("CNPJ formatado e quebra de parágrafo", () => {
  assert.equal(formatTaxId("12345678000190"), "12.345.678/0001-90");
  assert.equal(formatTaxId("abc"), "abc");
  assert.deepEqual(wrap("um dois três quatro", 9), ["um dois", "três", "quatro"]);
});

test("holerite: duas vias por página, rubricas, líquido protegido e declaração", () => {
  const result = monthlyPayroll({ competence: "2026-03", salary: 440_000, monthlyHours: 220, dependents: 0, overtime50Hours: 10, workingDays: 26, restDays: 5 });
  const pdf = payslipPdf([{ company, employee, competence: "2026-03", salaryCents: 440_000, lines: result.lines,
    earningsCents: result.earnings, deductionsCents: result.deductions, fgtsCents: result.fgts }]);
  const body = text(pdf);
  assert.ok(body.startsWith("%PDF-1.4"));
  assert.equal(pages(pdf), 1);
  assert.equal((body.match(/RECIBO DE PAGAMENTO DE SAL/gu) ?? []).length, 2);
  assert.match(body, /via do empregador/u);
  assert.match(body, /via do empregado/u);
  assert.match(body, /12\.345\.678\/0001-90/u);
  assert.match(body, /Horas extras 50%/u);
  // Valor com asteriscos à esquerda: não dá para acrescentar dígito depois.
  assert.match(body, /\*+[\d.]+,\d{2}/u);
  assert.match(body, /Declaro ter recebido/u);
  assert.match(body, /CPF final 1234/u);
});

test("férias: aviso (art. 135) e recibo (art. 145) em duas páginas", () => {
  const result = vacationPay({ start: "2026-07-01", salary: 300_000, entitledDays: 30, soldDays: 10, dependents: 0 });
  const pdf = vacationPdf({
    company, employee, acquisitiveStart: "2025-03-10", acquisitiveEnd: "2026-03-09", start: "2026-07-01", end: "2026-07-20",
    returnDate: "2026-07-21", restDays: 20, soldDays: 10, paymentDue: "2026-06-29",
    lines: result.lines, earningsCents: result.earnings, deductionsCents: result.deductions,
  });
  const body = text(pdf);
  assert.equal(pages(pdf), 2);
  assert.match(body, /AVISO DE F/u);
  assert.match(body, /RECIBO DE F/u);
  assert.match(body, /10\/03\/2025 a 09\/03\/2026/u);
  assert.match(body, /Abono pecuni/u);
});

test("rescisão: demonstrativo de verbas e termo de quitação", () => {
  const result = terminationPay({ kind: "without_cause", admissionDate: "2020-03-10", terminationDate: "2026-03-09", salary: 300_000, dependents: 0, fgtsBalance: 1_000_000 });
  const pdf = terminationPdf({
    company, employee, kindLabel: "Dispensa sem justa causa", terminationDate: "2026-03-09", projectedEnd: result.projectedEnd,
    noticeDays: result.noticeDays, paymentDue: "2026-03-19", lines: result.lines, earningsCents: result.earnings,
    deductionsCents: result.deductions, notes: result.notes,
  });
  const body = text(pdf);
  assert.match(body, /DEMONSTRATIVO DE VERBAS RESCIS/u);
  assert.match(body, /TERMO DE QUITA/u);
  assert.match(body, /art\. 477, \\247?2/u);
  assert.match(body, /45 dias/u);
  assert.match(body, /Multa do FGTS 40%/u);
});

test("as rotas dos documentos exigem a permissão de salário, o escopo de empresa e auditam", async () => {
  const payslips = await read("app/api/erp-dp/payroll-runs/[id]/payslips/route.ts");
  const documents = await read("app/api/erp-dp/calculations/document/route.ts");
  for (const source of [payslips, documents]) {
    assert.match(source, /requireCapability\(workspace, "payroll\.read"\)/u);
    assert.match(source, /prepareAuditEvent\(/u);
  }
  assert.match(payslips, /requireCompanyAccess\(/u);
  // O documento refaz a conta pelo mesmo serviço da tela.
  assert.match(documents, /await calculate\(d1, workspace, user\.id, body\)/u);
  assert.match(documents, /VACATION_NOT_ACQUIRED/u);
  assert.match(await read("lib/erp-calculation-service.ts"), /payrollEmployee\(/u);
});
