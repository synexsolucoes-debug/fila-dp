import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mostUrgentPeriod, validateSchedule, vacationPeriods, type VacationSchedule } from "../lib/vacation-balance.ts";
import { scheduleTransitions } from "../lib/vacation-service.ts";

/**
 * Controle de férias do ERP DP (§4.39 de docs/arquitetura-operacional.md):
 * períodos aquisitivo e concessivo, saldo, vencimento em dobro e as regras
 * da programação (CLT arts. 130, 134, 135, 137, 139 e 143).
 */

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const schedule = (overrides: Partial<VacationSchedule>): VacationSchedule => ({
  id: "s", acquisitiveStart: "2024-03-10", startDate: "2025-06-02", restDays: 30, soldDays: 0, entitledDays: 30, status: "taken", collective: false, ...overrides,
});

test("períodos aquisitivo e concessivo nascem da admissão", () => {
  const periods = vacationPeriods("2024-03-10", "2026-03-20", []);
  assert.deepEqual(periods.map((period) => [period.acquisitiveStart, period.acquisitiveEnd, period.concessiveEnd, period.status]), [
    ["2024-03-10", "2025-03-09", "2026-03-09", "overdue"],
    ["2025-03-10", "2026-03-09", "2027-03-09", "available"],
    ["2026-03-10", "2027-03-09", "2028-03-09", "acquiring"],
  ]);
});

test("saldo: gozado e programado saem do direito; quitado não alerta", () => {
  const periods = vacationPeriods("2024-03-10", "2026-03-20", [
    schedule({ acquisitiveStart: "2024-03-10", restDays: 20, soldDays: 10, status: "taken" }),
    schedule({ id: "b", acquisitiveStart: "2025-03-10", startDate: "2026-04-06", restDays: 15, status: "approved" }),
  ]);
  assert.equal(periods[0].status, "settled");
  assert.equal(periods[1].balance, 15);
  assert.equal(periods[1].scheduledDays, 15);
  // Cancelada não conta.
  const canceled = vacationPeriods("2024-03-10", "2026-03-20", [schedule({ status: "canceled" })]);
  assert.equal(canceled[0].balance, 30);
});

test("vencendo em 60 dias e o período mais urgente primeiro", () => {
  const periods = vacationPeriods("2024-03-10", "2026-01-20", []);
  assert.equal(periods[0].status, "expiring");
  assert.equal(mostUrgentPeriod(periods)?.acquisitiveStart, "2024-03-10");
});

test("regras da programação: fração mínima, 14 dias, abono, sexta e sábado, saldo, três frações", () => {
  const periods = vacationPeriods("2024-03-10", "2026-03-20", []);
  const period = periods[1];
  const base = { acquisitiveStart: period.acquisitiveStart, entitledDays: 30, soldDays: 0 };
  // 2026-04-06 é segunda-feira.
  const ok = validateSchedule({ ...base, startDate: "2026-04-06", restDays: 20, soldDays: 10 }, period, [], "2026-03-01");
  assert.equal(ok.end, "2026-04-25");
  assert.equal(ok.returnDate, "2026-04-26");
  assert.equal(ok.paymentDue, "2026-04-04");
  assert.throws(() => validateSchedule({ ...base, startDate: "2026-04-06", restDays: 4 }, period, [], "2026-03-01"), code("VACATION_FRACTION_TOO_SHORT"));
  assert.throws(() => validateSchedule({ ...base, startDate: "2026-04-10", restDays: 20 }, period, [], "2026-03-01"), code("VACATION_START_BEFORE_REST"));
  assert.throws(() => validateSchedule({ ...base, startDate: "2026-04-11", restDays: 20 }, period, [], "2026-03-01"), code("VACATION_START_BEFORE_REST"));
  assert.throws(() => validateSchedule({ ...base, startDate: "2026-04-06", restDays: 19, soldDays: 11 }, period, [], "2026-03-01"), code("VACATION_SALE_TOO_LONG"));
  const two = [schedule({ id: "a", acquisitiveStart: period.acquisitiveStart, restDays: 10, status: "planned" }), schedule({ id: "b", acquisitiveStart: period.acquisitiveStart, restDays: 10, status: "planned" })];
  // Duas frações de 10 e a última de 10: nenhuma chega a 14.
  assert.throws(() => validateSchedule({ ...base, startDate: "2026-04-06", restDays: 10 }, period, two, "2026-03-01"), code("VACATION_NO_LONG_FRACTION"));
  const three = [...two, schedule({ id: "c", acquisitiveStart: period.acquisitiveStart, restDays: 5, status: "planned" })];
  assert.throws(() => validateSchedule({ ...base, startDate: "2026-04-06", restDays: 5 }, period, three, "2026-03-01"), code("VACATION_TOO_MANY_FRACTIONS"));
  assert.throws(() => validateSchedule({ ...base, startDate: "2026-04-06", restDays: 31 }, period, [], "2026-03-01"), code("VACATION_BALANCE_EXCEEDED"));
});

test("período em aquisição só em férias coletivas; aviso curto e concessivo vencido avisam", () => {
  const periods = vacationPeriods("2025-09-01", "2026-03-20", []);
  const acquiring = periods[0];
  assert.throws(() => validateSchedule({ acquisitiveStart: acquiring.acquisitiveStart, startDate: "2026-04-06", restDays: 20, soldDays: 0, entitledDays: 30 }, acquiring, [], "2026-03-20"),
    code("VACATION_NOT_ACQUIRED"));
  const collective = validateSchedule({ acquisitiveStart: acquiring.acquisitiveStart, startDate: "2026-04-06", restDays: 20, soldDays: 0, entitledDays: 30, collective: true }, acquiring, [], "2026-03-20");
  assert.ok(collective.warnings.some((warning) => /30 dias de antecedência/u.test(warning)));
  const overdue = vacationPeriods("2023-03-10", "2026-03-20", [])[0];
  const late = validateSchedule({ acquisitiveStart: overdue.acquisitiveStart, startDate: "2026-04-06", restDays: 30, soldDays: 0, entitledDays: 30 }, overdue, [], "2026-03-01");
  assert.ok(late.warnings.some((warning) => /em dobro/u.test(warning)));
});

test("estados: gozada e cancelada não voltam", () => {
  assert.deepEqual([...scheduleTransitions.planned], ["approved", "canceled"]);
  assert.deepEqual([...scheduleTransitions.approved], ["taken", "canceled"]);
  assert.deepEqual([...scheduleTransitions.taken], []);
  assert.deepEqual([...scheduleTransitions.canceled], []);
});

test("tabelas isoladas por tenant, com as guardas da CLT, e rotas com permissão e auditoria", async () => {
  const migration = await read("drizzle/postgres/0116_erp_dp_vacations.sql");
  for (const table of ["fdp_vacation_schedules", "fdp_collective_vacations"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"));
  }
  assert.match(migration, /"rest_days" \+ "sold_days" <= "entitled_days"/u);
  assert.match(migration, /"rest_days" BETWEEN 10 AND 30/u);
  assert.doesNotMatch(migration, /DELETE FROM/u);
  const employeeRoute = await read("app/api/employees/[id]/vacations/route.ts");
  const statusRoute = await read("app/api/erp-dp/vacations/[id]/route.ts");
  const collective = await read("app/api/erp-dp/vacations/collective/route.ts");
  assert.match(employeeRoute, /requireCapability\(workspace, "employees\.read"\)/u);
  for (const source of [employeeRoute, statusRoute, collective]) {
    assert.match(source, /requireCapability\(workspace, "employees\.manage"\)/u);
    assert.match(source, /prepareAuditEvent\(/u);
  }
  assert.match(statusRoute, /AND status = \?/u);
  assert.match(collective, /COLLECTIVE_TOO_SHORT/u);
});
