import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parsePayrollTextPages } from "../lib/payroll-pdf.ts";

test("resumo Pessoal+ vira indicadores consolidados sem recalcular tributos", () => {
  const parsed = parsePayrollTextPages([
    `Pessoal +\nULTRA TELECOM - 26.016.500/0001-05\nCompetência: 01/2026\n 5.325,079010 - INSS\n 1.224,159040 - IRRF\n 550,009120 - INSS - PRO LABORE\nTotal Líquido:\n61.822,45\n35.261,75Sal. Base: 53.373,53\nTotal de Descontos:Total Bruto: 8.448,92\nAdmitidos no 0 0Demitidos no Afastados no 0 Total de 15`,
    `Dados FGTS\nTotal: 4.924,7261.559,07\nParte Empresa: 12.336,65\nRAT Ajustado (FAP: 0,50 x RAT: 2,00 ): 566,83\nOutros: 3.287,63`,
  ]);
  assert.equal(parsed.model, "sankhya_summary");
  assert.equal(parsed.period, "2026-01");
  assert.equal(parsed.headcount, 15);
  assert.equal(parsed.grossPayroll, 61822.45);
  assert.equal(parsed.totalDeductions, 8448.92);
  assert.equal(parsed.netPay, 53373.53);
  assert.equal(parsed.employerCharges, 21115.83);
  assert.equal(parsed.payrollCost, 82938.28);
});

test("extrato mensal Domínio reconhece colaboradores, totais e encargos", () => {
  const parsed = parsePayrollTextPages([
    `EXTRATO MENSAL\n05/2026\nEmpresa:\nCompetência:\nCálculo: Folha Mensal\n26.016.500/0001-05\n254 - ULTRA TELECOMUNICACOES LTDA\nCNPJ:\n5 PESSOA UMEmpr.: 01/01/2025\n6 PESSOA DOISEmpr.: 02/01/2025`,
    "", "",
    `Total Geral Proventos: Total Geral Descontos:64.670,24 22.761,12\nLíquido Geral: 41.909,12`,
    "",
    `FGTS, PIS e ISS\n4.195,34Salário contribuição contribuintes: 5.000,00 Valor do FGTS:\nSegurados: 5.541,80\nEmpresa: 10.488,43\nRAT: 786,63\nTerceiros: 3.041,63\nValor Total do IRRF: Valor Total do IRRF:1.066,73 216,08`,
  ]);
  assert.equal(parsed.model, "dominio_analytical");
  assert.equal(parsed.period, "2026-05");
  assert.equal(parsed.headcount, 2);
  assert.equal(parsed.employeeInss, 5541.8);
  assert.equal(parsed.employeeIrrf, 1066.73);
  assert.equal(parsed.fgts, 4195.34);
  assert.equal(parsed.employerCharges, 18512.03);
  assert.equal(parsed.payrollCost, 83182.27);
});

test("importador de PDF exige acesso, faz prévia e atualiza a competência com auditoria", async () => {
  const [route, view, dialog] = await Promise.all([
    readFile(new URL("../app/api/hr-metrics/import/pdf/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payroll/PayrollImportDialog.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /requireCapability\(workspace, "hr\.write"\)/u);
  assert.match(route, /PAYROLL_COMPANY_MISMATCH/u);
  assert.match(route, /ON CONFLICT\(workspace_id, company_id, period\) DO UPDATE/u);
  assert.match(route, /hr_metric\.pdf_imported/u);
  assert.match(view, /Importar extrato PDF/u);
  assert.match(view, /metric\.source === "pdf_import" \? "PDF"/u);
  assert.match(dialog, /Nenhum dado é gravado durante a análise/u);
  assert.match(dialog, /não recalcula impostos ou encargos/u);
});
