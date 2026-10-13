import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  monthlySalaryOf, parseMoney, parseRemunerationInput, planRemuneration, remunerationAt, remunerationGaps, type Remuneration,
} from "../lib/remuneration.ts";
import { hasCapability } from "../lib/authorization.ts";
import { capabilityCatalog } from "../lib/capability-catalog.ts";
import { moduleWriteCapabilities } from "../lib/modules.ts";

/**
 * Remuneração do ERP DP (infotipo 0008 do SAP) — §4.31 de
 * docs/arquitetura-operacional.md. O cálculo só é tão certo quanto o salário
 * que ele lê: vigência sem buraco, aumento que delimita, correção que não
 * inventa período, e salário visível só para quem pode ver.
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

const record = (id: string, validFrom: string, validTo: string, amountCents = 300_000): Remuneration => ({
  id, validFrom, validTo, salaryKind: "monthly", amountCents, monthlyHours: 220, irrfDependents: 0,
  unhealthyPercent: 0, hazardous: false, transportVoucherCents: 0, mealVoucherDiscountCents: 0, reason: "admission", notes: "",
});

test("valor em reais vira centavos, no formato brasileiro ou não", () => {
  assert.equal(parseMoney("3.500,00"), 350_000);
  assert.equal(parseMoney("R$ 1.621,5"), 162_150);
  assert.equal(parseMoney("3500.75"), 350_075);
  assert.equal(parseMoney("3500"), 350_000);
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney("abc"), null);
});

test("a entrada é validada: vigência, valor, motivo e adicionais que não se acumulam", () => {
  const ok = parseRemunerationInput({ validFrom: "2026-03-01", amount: "3.500,00", reason: "raise", irrfDependents: 2 }, "2020-01-10");
  assert.equal(ok.amountCents, 350_000);
  assert.equal(ok.monthlyHours, 220);
  assert.equal(ok.irrfDependents, 2);
  assert.throws(() => parseRemunerationInput({ validFrom: "2019-12-31", amount: "1", reason: "raise" }, "2020-01-10"), code("REMUNERATION_BEFORE_ADMISSION"));
  assert.throws(() => parseRemunerationInput({ validFrom: "2026-03-01", amount: "0", reason: "raise" }, "2020-01-10"), code("REMUNERATION_AMOUNT_INVALID"));
  assert.throws(() => parseRemunerationInput({ validFrom: "2026-03-01", amount: "10", reason: "x" }, "2020-01-10"), code("REMUNERATION_REASON_REQUIRED"));
  assert.throws(() => parseRemunerationInput({ validFrom: "2026-03-01", amount: "10", reason: "raise", hazardous: true, unhealthyPercent: 20 }, "2020-01-10"),
    code("REMUNERATION_ADDITIONALS_EXCLUSIVE"));
  assert.throws(() => parseRemunerationInput({ validFrom: "2026-03-01", amount: "10", reason: "raise", unhealthyPercent: 15 }, "2020-01-10"),
    code("REMUNERATION_UNHEALTHY_INVALID"));
});

test("horista vira salário mensal pelas horas do contrato", () => {
  assert.equal(monthlySalaryOf({ salaryKind: "hourly", amountCents: 2_000, monthlyHours: 220 }), 440_000);
  assert.equal(monthlySalaryOf({ salaryKind: "monthly", amountCents: 440_000, monthlyHours: 220 }), 440_000);
});

test("aumento delimita o registro vigente na véspera; mesmo início é correção", () => {
  const records = [record("a", "2020-01-10", "9999-12-31")];
  assert.deepEqual(planRemuneration(records, "2026-03-01"), { mode: "insert", validTo: "9999-12-31", delimit: { id: "a", validTo: "2026-02-28" } });
  assert.deepEqual(planRemuneration(records, "2020-01-10"), { mode: "correct", id: "a" });
  // Antes do primeiro registro: vai até a véspera dele.
  const later = [record("b", "2024-01-01", "9999-12-31")];
  assert.deepEqual(planRemuneration(later, "2023-06-01"), { mode: "insert", validTo: "2023-12-31", delimit: null });
  // No meio do histórico: o novo vai até onde o delimitado ia.
  const history = [record("a", "2020-01-10", "2023-12-31"), record("b", "2024-01-01", "9999-12-31")];
  assert.deepEqual(planRemuneration(history, "2022-05-01"), { mode: "insert", validTo: "2023-12-31", delimit: { id: "a", validTo: "2022-04-30" } });
});

test("o cálculo lê o salário vigente na data, e a tela vê os buracos", () => {
  const history = [record("a", "2020-01-10", "2023-12-31", 200_000), record("b", "2024-01-01", "9999-12-31", 300_000)];
  assert.equal(remunerationAt(history, "2023-12-31")?.amountCents, 200_000);
  assert.equal(remunerationAt(history, "2024-01-01")?.amountCents, 300_000);
  assert.deepEqual(remunerationGaps(history), []);
  assert.deepEqual(remunerationGaps([record("a", "2020-01-10", "2023-11-30"), record("b", "2024-01-01", "9999-12-31")]), ["Entre 2023-11-30 e 2024-01-01"]);
});

test("salário é permissão própria: membro vê e grava, observador não vê", () => {
  assert.ok(hasCapability("member", "payroll.read"));
  assert.ok(hasCapability("member", "payroll.manage"));
  assert.ok(!hasCapability("observer", "payroll.read"));
  assert.ok(!hasCapability("guest", "payroll.read"));
  assert.ok(capabilityCatalog["payroll.read"].label.length > 0);
  // Negar o módulo Folha fecha a escrita do salário.
  assert.ok(moduleWriteCapabilities.payroll.includes("payroll.manage"));
});

test("a tabela nasce isolada por tenant, com vigência e as guardas da CLT", async () => {
  const migration = await read("drizzle/postgres/0111_erp_dp_remuneration.sql");
  assert.match(migration, /CREATE TABLE "fdp_employee_remuneration"/u);
  assert.match(migration, /ALTER TABLE "fdp_employee_remuneration" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /CREATE POLICY "fdp_employee_remuneration_workspace_isolation"/u);
  assert.match(migration, /"valid_to" date DEFAULT '9999-12-31' NOT NULL/u);
  assert.match(migration, /fdp_employee_remuneration_employee_start_uq/u);
  assert.match(migration, /NOT \("hazardous" AND "unhealthy_percent" > 0\)/u);
  assert.doesNotMatch(migration, /DELETE FROM/u);
});

test("as rotas exigem a permissão de salário, escopo de empresa e auditam", async () => {
  const route = await read("app/api/employees/[id]/remuneration/route.ts");
  const calc = await read("app/api/erp-dp/calculations/route.ts");
  const service = await read("lib/erp-payroll-service.ts");
  assert.match(route, /requireCapability\(workspace, "payroll\.read"\)/u);
  assert.match(route, /requireCapability\(workspace, "payroll\.manage"\)/u);
  assert.match(route, /employee\.remuneration\.created/u);
  assert.match(route, /employee\.remuneration\.corrected/u);
  assert.match(route, /await d1\.batch\(statements\)/u);
  assert.match(calc, /requireCapability\(workspace, "payroll\.read"\)/u);
  assert.match(service, /requireCompanyAccess\(/u);
  // O cálculo usa o salário da data, não o de hoje.
  assert.match(calc, /remunerationAt\(records, referenceDate\)/u);
});

test("o cálculo mora no ERP: a tela e o motor não puxam código de servidor", async () => {
  const view = await read("app/painel/features/erp-dp/ErpDpView.tsx");
  assert.match(view, /\{ id: "calculations", label: "Cálculos"/u);
  assert.match(view, /\(item\.id !== "calculations" && item\.id !== "payroll"\) \|\| canReadPayroll/u);
  assert.match(view, /item\.id !== "remuneration" \|\| canReadPayroll/u);
  for (const path of ["lib/payroll-calc.ts", "lib/payroll-tables.ts", "lib/remuneration.ts"]) {
    const source = await read(path);
    const modules = [...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);
    assert.ok(modules.every((item) => item === "./payroll-tables.ts"), `${path}: ${modules.join(", ")}`);
  }
});
