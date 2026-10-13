import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { costTotals, employeeCost, groupCosts } from "../lib/payroll-costs.ts";
import { monthlyPayroll } from "../lib/payroll-calc.ts";
import { defaultSettings } from "../lib/payroll-obligations.ts";
import { assertEmployeePortalLinkUsable, employeePortalLinkStatus, portalInstant } from "../lib/employee-portal-status.ts";

/**
 * Custo de pessoal e portal do colaborador do ERP DP (§4.37 de
 * docs/arquitetura-operacional.md).
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const input = (overrides: Partial<Parameters<typeof employeeCost>[0]> = {}, category?: "intern") => {
  const payroll = monthlyPayroll({ competence: "2026-03", salary: 300_000, monthlyHours: 220, dependents: 0, transportVoucherCost: 30_000, category });
  return { employeeId: "e", name: "Ana", registrationNumber: "1", departmentName: "DP", costCenterName: "ADM", salaryCents: 300_000,
    earningsCents: payroll.earnings, fgtsCents: payroll.fgts, transportVoucherCents: 30_000, lines: payroll.lines, ...overrides };
};

test("custo da pessoa: patronal, FGTS, provisões com encargos e o VT que a empresa banca", () => {
  const cost = employeeCost(input(), defaultSettings);
  assert.equal(cost.employerContribution, Math.round(300_000 * 0.278));
  assert.equal(cost.fgts, 24_000);
  assert.equal(cost.vacationProvision, 33_333);
  assert.equal(cost.thirteenthProvision, 25_000);
  assert.equal(cost.provisionCharges, Math.round((33_333 + 25_000) * (0.278 + 0.08)));
  // VT: custo de R$ 300 menos o desconto de 6% (R$ 180).
  assert.equal(cost.transportVoucher, 12_000);
  assert.equal(cost.total, cost.earnings + cost.employerContribution + cost.fgts + cost.vacationProvision + cost.thirteenthProvision + cost.provisionCharges + cost.transportVoucher);
  const simples = employeeCost(input(), { ...defaultSettings, employerContribution: "simples_exempt" });
  assert.equal(simples.employerContribution, 0);
});

test("estagiário não tem provisão de férias e 13º da CLT nem patronal", () => {
  const cost = employeeCost(input({}, "intern"), defaultSettings);
  assert.equal(cost.employerContribution, 0);
  assert.equal(cost.vacationProvision, 0);
  assert.equal(cost.thirteenthProvision, 0);
  assert.equal(cost.fgts, 0);
});

test("agrupa por centro de custo e departamento, sem esconder quem não tem", () => {
  const a = employeeCost(input(), defaultSettings);
  const b = employeeCost(input({ employeeId: "b", costCenterName: "" }), defaultSettings);
  const groups = groupCosts([a, b], "costCenterName");
  assert.deepEqual(groups.map((group) => group.key).sort(), ["ADM", "Sem centro de custo"]);
  assert.equal(costTotals([a, b]).total, a.total + b.total);
  assert.equal(groupCosts([a], "departmentName")[0].key, "DP");
});

test("link do portal: ativo, revogado e vencido", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(employeePortalLinkStatus({ expires_at: future }), "active");
  assert.equal(employeePortalLinkStatus({ expires_at: future, revoked_at: "2026-01-01" }), "revoked");
  // O driver do PostgreSQL devolve Date: a API manda ISO, não "Thu Nov 12 …".
  assert.equal(portalInstant(new Date("2026-11-12T15:00:00.000Z")), "2026-11-12T15:00:00.000Z");
  assert.equal(portalInstant("2026-11-12T15:00:00Z"), "2026-11-12T15:00:00Z");
  assert.equal(employeePortalLinkStatus({ expires_at: "2020-01-01" }), "expired");
  assert.throws(() => assertEmployeePortalLinkUsable({ expires_at: "2020-01-01" }), code("EMPLOYEE_PORTAL_EXPIRED"));
  assert.throws(() => assertEmployeePortalLinkUsable({ expires_at: future, revoked_at: "2026-01-01" }), code("EMPLOYEE_PORTAL_REVOKED"));
  assert.doesNotThrow(() => assertEmployeePortalLinkUsable({ expires_at: future }));
});

test("portal: só hash, inquilino do token, limite de tentativas e só a própria pessoa", async () => {
  const route = await read("app/api/portal/colaborador/[token]/route.ts");
  const payslip = await read("app/api/portal/colaborador/[token]/holerite/route.ts");
  const lib = await read("lib/employee-portal.ts");
  assert.match(route, /hashPortalToken\(/u);
  assert.match(route, /getScopedD1\(\{ workspaceId: parsed\.workspaceId \}\)/u);
  assert.match(route, /consumePublicAuthRateLimit\("employee_portal"/u);
  assert.match(route, /assertEmployeePortalLinkUsable\(link\)/u);
  assert.match(lib, /getScopedD1\(\{ workspaceId: parsed\.workspaceId \}\)/u);
  assert.match(payslip, /assertEmployeePortalLinkUsable\(link\)/u);
  // O holerite é só da pessoa do link, e só de folha fechada.
  assert.match(payslip, /item\.employeeId === link\.employee_id/u);
  assert.match(payslip, /status = 'closed'/u);
  // Pedido de férias passa pelas regras da CLT e vai para o DP aprovar.
  assert.match(route, /prepareSchedule\(d1,/u);
  assert.match(route, /employee\.vacation\.requested/u);
  const migration = await read("drizzle/postgres/0116_erp_dp_employee_portal.sql");
  assert.match(migration, /"token_hash" text NOT NULL/u);
  assert.match(migration, /fdp_employee_portal_links_token_uq/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
});

test("gerar e revogar link exigem permissão de salário e ficam na auditoria; custos com payroll.read", async () => {
  const links = await read("app/api/erp-dp/portal-links/route.ts");
  const revoke = await read("app/api/erp-dp/portal-links/[id]/route.ts");
  for (const source of [links, revoke]) {
    assert.match(source, /requireCapability\(workspace, "payroll\.manage"\)/u);
    assert.match(source, /prepareAuditEvent\(/u);
  }
  // O token só sai na criação; a lista nunca devolve hash nem token.
  assert.doesNotMatch(links.slice(links.indexOf("export async function GET"), links.indexOf("export async function POST")), /token_hash|token\.token/u);
  assert.match(await read("app/api/erp-dp/costs/route.ts"), /requireCapability\(workspace, "payroll\.read"\)/u);
});
