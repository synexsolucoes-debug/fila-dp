import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { businessMinutesBetween, evaluateSla, type SlaCalendar } from "../lib/fila-dp-sla.ts";
import { decryptSecret, encryptSecret } from "../lib/fila-dp-secrets.ts";
import { calculatePjClosing, calculatePjContractAmount, moneyToCents } from "../lib/fila-dp-money.ts";
import { isValidCnpj, parseEmployeeSheetRows } from "../lib/employee-workbook-source.ts";

const calendar: SlaCalendar = {
  businessDays: [1, 2, 3, 4, 5],
  holidays: new Set(),
  dayStart: "08:00",
  dayEnd: "18:00",
  timezone: "America/Sao_Paulo",
};

test("calcula minutos úteis no fuso do workspace e ignora a noite", () => {
  assert.equal(businessMinutesBetween("2026-08-03T11:00:00Z", "2026-08-03T23:00:00Z", calendar), 600);
  assert.equal(businessMinutesBetween("2026-08-03T23:00:00Z", "2026-08-04T11:00:00Z", calendar), 0);
});

test("persiste níveis previsíveis de escalonamento do SLA", () => {
  const input = { behavior: "running", activePause: false, dueAt: null, targetMinutes: 600, startedAt: "2026-08-03T11:00:00Z", pausedMinutes: 0, warningBusinessDays: 0 };
  assert.deepEqual(evaluateSla(input, calendar, new Date("2026-08-03T20:00:00Z")), { status: "safe", elapsedMinutes: 540, overdueMinutes: 0, escalationLevel: 0 });
  assert.equal(evaluateSla(input, calendar, new Date("2026-08-04T15:00:00Z")).escalationLevel, 1);
  assert.equal(evaluateSla(input, calendar, new Date("2026-08-05T15:00:00Z")).escalationLevel, 2);
  assert.equal(evaluateSla({ ...input, activePause: true }, calendar, new Date("2026-08-05T15:00:00Z")).status, "paused");
});

test("fecha valores PJ em centavos e separa nota, reembolso e excedente", () => {
  assert.equal(moneyToCents("1234,56"), 123456);
  const closing = calculatePjClosing({ contractAmount: "5000.00", variableAmount: "750.25", reimbursementAmount: "200.00", deductionsAmount: "150.10", invoiceLimit: "5000.00", invoiceAmount: "5000.00" });
  assert.equal(closing.expectedInvoiceAmount, 5000);
  assert.equal(closing.cajuExcess, 600.15);
  assert.equal(closing.netAmount, 5800.15);
  assert.equal(closing.invoiceDivergent, false);
  assert.equal(calculatePjClosing({ contractAmount: 5000, variableAmount: 0, reimbursementAmount: 0, deductionsAmount: 0, invoiceLimit: 5000, invoiceAmount: 4900 }).invoiceDivergent, true);
});

test("calcula contrato PJ em 30 dias e aplica proporcional no mês de início", () => {
  assert.equal(calculatePjContractAmount(5000, null, "2026-08"), 5000);
  assert.equal(calculatePjContractAmount(5000, "2026-07-20", "2026-08"), 5000);
  assert.equal(calculatePjContractAmount(5000, "2026-08-16", "2026-08"), 2500);
  assert.equal(calculatePjContractAmount(5000, "2026-08-31", "2026-08"), 166.67);
  assert.equal(calculatePjContractAmount(5000, "2026-09-01", "2026-08"), 0);
  assert.equal(calculatePjContractAmount(5000, "2026-02-31", "2026-02"), 5000);
});

test("mapeia a fonte de funcionários sem importar fórmulas quebradas", () => {
  const header = Array(35).fill(null);
  Object.assign(header, { 2: "COLABORADOR", 6: "CPF", 7: "EMPRESA" });
  const pj = Array(35).fill(null);
  Object.assign(pj, { 2: "Prestador Teste", 4: "Coordenador", 5: "NOC", 6: "123.456.789-00", 7: "PJ", 8: "ULTRA", 11: 8000, 19: 750, 20: "X", 21: 46064, 34: "pj@example.com" });
  const clt = Array(35).fill(null);
  Object.assign(clt, { 2: "Funcionária Teste", 4: "Analista", 5: "DP", 6: "987.654.321-00", 7: "OPYT", 8: "INHUMAS", 11: 3205.58, 19: 1000, 20: 223.6, 29: "10.299.958/0001-89" });
  const records = parseEmployeeSheetRows([[], header, pj, clt]);
  assert.equal(records.length, 2);
  assert.equal(records[0].regime, "pj");
  assert.equal(records[0].companyLabel, "ULTRA");
  assert.equal(records[0].transportBenefit, 0);
  assert.equal(records[1].regime, "clt");
  assert.equal(records[1].companyTaxId, "10299958000189");
  assert.equal(records[1].transportBenefit, 223.6);
  assert.equal(isValidCnpj("10.299.958/0001-89"), true);
  assert.equal(isValidCnpj("26.016.5000/0001-05"), false);
});

test("protege credenciais OAuth com criptografia autenticada", () => {
  const previous = process.env.FDP_INTEGRATION_ENCRYPTION_KEY;
  process.env.FDP_INTEGRATION_ENCRYPTION_KEY = "test-key-with-at-least-thirty-two-bytes";
  try {
    const encrypted = encryptSecret({ accessToken: "secret", refreshToken: "refresh" });
    assert.doesNotMatch(encrypted, /secret|refresh/);
    assert.deepEqual(decryptSecret(encrypted), { accessToken: "secret", refreshToken: "refresh" });
    const tampered = encrypted.split(".");
    tampered[2] = `${tampered[2][0] === "A" ? "B" : "A"}${tampered[2].slice(1)}`;
    assert.throws(() => decryptSecret(tampered.join(".")));
  } finally {
    if (previous === undefined) delete process.env.FDP_INTEGRATION_ENCRYPTION_KEY;
    else process.env.FDP_INTEGRATION_ENCRYPTION_KEY = previous;
  }
});

test("mantém detalhamento Sankhya e protege tarefas agendadas", async () => {
  const [sync, cron, migration, webhook] = await Promise.all([
    readFile(new URL("../app/api/integrations/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/cron/sla/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0003_operational_hardening.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/webhook/[channel]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(sync, /base_salary = excluded\.base_salary/);
  assert.doesNotMatch(sync, /base_salary = 0/);
  assert.match(cron, /Bearer \$\{cronSecret\}/);
  assert.match(migration, /fdp_auth_rate_limits/);
  assert.match(migration, /fdp_calendar_credentials/);
  assert.match(migration, /fdp_inbox_workspace_channel_external_uq/);
  assert.match(webhook, /x-hub-signature-256/);
  assert.match(webhook, /phone_number_id/);
  assert.match(webhook, /metaWhatsappMessages/);
  assert.match(webhook, /ON CONFLICT \(workspace_id, channel, external_id\) DO NOTHING/);
});

test("entrega funcionários, benefícios e fechamento PJ como módulos reais", async () => {
  const [migration, employees, employeeImport, benefits, pj, views, health] = await Promise.all([
    readFile(new URL("../drizzle/postgres/0004_people_benefits_pj.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employees/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employees/import/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/benefits/movements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pj-closings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/PeopleOperationsViews.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /fdp_people/);
  assert.match(migration, /fdp_employments/);
  assert.match(migration, /fdp_benefit_policies/);
  assert.match(migration, /fdp_pj_closings/);
  assert.match(employees, /requireCompanyAccess/);
  assert.match(employeeImport, /requireWorkspaceRole\(workspace\.role, \["admin"\]\)/);
  assert.match(employeeImport, /EMPLOYEE_WORKBOOK_SOURCE/);
  assert.match(employeeImport, /benefitMovements/);
  assert.match(benefits, /eligible_regime/);
  assert.match(pj, /invoiceDivergent/);
  assert.match(pj, /contractAmount: calculatedContractAmount/);
  assert.match(views, /Central de funcionários/i);
  assert.match(views, /Fechamento PJ/i);
  assert.match(health, /migration_required/);
  assert.match(health, /fdp_pj_closings/);
});
