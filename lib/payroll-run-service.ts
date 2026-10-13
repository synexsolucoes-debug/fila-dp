import { ApiError } from "./api-errors.ts";
import { prepareAuditEvent } from "./fila-dp-db";
import { lastDayOfCompetence } from "./erp-dp.ts";
import { ledgerCategoryLabels, type LedgerCategory } from "./payroll-ledger.ts";
import { variableAverage, type PayrollLine } from "./payroll-calc.ts";
import { monthlySalaryOf, remunerationAt, remunerationFromRow, type Remuneration } from "./remuneration.ts";
import {
  eligibility, employeePayroll, runTotals,
  type EmployeePayroll, type InstallmentInput, type RetroInput, type RunEmployee, type TimeInput,
} from "./payroll-run.ts";

/**
 * Folha da competência do ERP DP: lê as entradas do banco, monta cada
 * colaborador com `lib/payroll-run.ts` e grava o resultado num lote só.
 */

const day = (value: unknown) => value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : null;
const cents = (reais: unknown) => Math.round(Number(reais ?? 0) * 100);

export type RunRow = {
  id: string; companyId: string; payrollCycleId: string; competence: string; status: "calculated" | "closed";
  calculationCount: number; employeesCount: number; earningsCents: number; deductionsCents: number; netCents: number; fgtsCents: number;
  skipped: Array<{ employeeId: string; name: string; registrationNumber: string; reason: string }>;
  calculatedAt: string; closedAt: string | null;
};

export function runFromRow(row: Record<string, unknown>): RunRow {
  const skipped = typeof row.skipped_json === "string" ? JSON.parse(row.skipped_json) : row.skipped_json;
  return {
    id: String(row.id), companyId: String(row.company_id), payrollCycleId: String(row.payroll_cycle_id), competence: String(row.competence),
    status: row.status === "closed" ? "closed" : "calculated", calculationCount: Number(row.calculation_count),
    employeesCount: Number(row.employees_count), earningsCents: Number(row.earnings_cents), deductionsCents: Number(row.deductions_cents),
    netCents: Number(row.net_cents), fgtsCents: Number(row.fgts_cents), skipped: Array.isArray(skipped) ? skipped : [],
    calculatedAt: String(row.calculated_at), closedAt: row.closed_at ? String(row.closed_at) : null,
  };
}

const json = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);

export async function cycleFor(d1: SqlDatabase, workspaceId: string, companyId: string, competence: string) {
  const cycle = await d1.prepare("SELECT id, status FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND competence = ?")
    .bind(workspaceId, companyId, competence).first<{ id: string; status: string }>();
  if (!cycle) throw ApiError.badRequest("Abra a competência desta empresa em Competências antes de calcular a folha.", "PAYROLL_CYCLE_MISSING");
  return cycle;
}

export async function runFor(d1: SqlDatabase, workspaceId: string, cycleId: string) {
  const row = await d1.prepare("SELECT * FROM fdp_payroll_runs WHERE workspace_id = ? AND payroll_cycle_id = ?")
    .bind(workspaceId, cycleId).first<Record<string, unknown>>();
  return row ? runFromRow(row) : null;
}

export async function runResults(d1: SqlDatabase, workspaceId: string, runId: string) {
  const rows = await d1.prepare(`SELECT r.*, e.full_name, e.registration_number FROM fdp_payroll_results r
      JOIN fdp_employees e ON e.workspace_id = r.workspace_id AND e.id = r.employee_id
      WHERE r.workspace_id = ? AND r.run_id = ? ORDER BY e.full_name`).bind(workspaceId, runId).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: String(row.id), employeeId: String(row.employee_id), name: String(row.full_name ?? ""), registrationNumber: String(row.registration_number ?? ""),
    salaryCents: Number(row.salary_cents), earningsCents: Number(row.earnings_cents), deductionsCents: Number(row.deductions_cents),
    netCents: Number(row.net_cents), fgtsCents: Number(row.fgts_cents),
    lines: json(row.lines_json) as PayrollLine[], inputs: json(row.inputs_json) as Record<string, unknown>, notes: json(row.notes_json) as string[],
  }));
}

/** Folhas fechadas da pessoa — a base da média de variáveis. */
export async function closedResultsOf(d1: SqlDatabase, workspaceId: string, employeeId: string) {
  const rows = await d1.prepare(`SELECT r.competence, r.lines_json, r.salary_cents, r.inputs_json FROM fdp_payroll_results r
      JOIN fdp_payroll_runs u ON u.workspace_id = r.workspace_id AND u.id = r.run_id
      WHERE r.workspace_id = ? AND r.employee_id = ? AND u.status = 'closed' ORDER BY r.competence`)
    .bind(workspaceId, employeeId).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    competence: String(row.competence), lines: json(row.lines_json) as PayrollLine[],
    salaryCents: Number(row.salary_cents), inputs: json(row.inputs_json) as Record<string, unknown>,
  }));
}

export async function autoVariableAverage(d1: SqlDatabase, workspaceId: string, employeeId: string, referenceDate: string) {
  return variableAverage(await closedResultsOf(d1, workspaceId, employeeId), referenceDate);
}

/** Calcula (ou recalcula) a folha da competência da empresa inteira. */
export async function calculateRun(d1: SqlDatabase, input: {
  workspaceId: string; companyId: string; competence: string; userId: string; userEmail: string; requestId: string | null;
}) {
  const { workspaceId, companyId, competence } = input;
  const cycle = await cycleFor(d1, workspaceId, companyId, competence);
  if (cycle.status === "closed") throw ApiError.badRequest("A competência está encerrada: reabra em Competências para recalcular.", "PAYROLL_CYCLE_CLOSED");
  const existing = await runFor(d1, workspaceId, cycle.id);
  if (existing?.status === "closed") throw ApiError.badRequest("A folha desta competência já foi fechada. O que mudar agora entra como diferença na próxima.", "PAYROLL_RUN_CLOSED");

  const monthEnd = lastDayOfCompetence(competence);
  const employeeRows = await d1.prepare(`SELECT id, full_name, registration_number, admission_date, termination_date, employment_status, employment_type
      FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND admission_date <= ?::date
        AND (termination_date IS NULL OR termination_date >= ?::date) ORDER BY full_name`)
    .bind(workspaceId, companyId, monthEnd, `${competence}-01`).all<Record<string, unknown>>();
  const employees: RunEmployee[] = (employeeRows.results ?? []).map((row) => ({
    id: String(row.id), fullName: String(row.full_name ?? ""), registrationNumber: String(row.registration_number ?? ""),
    admissionDate: day(row.admission_date) ?? "", terminationDate: day(row.termination_date), employmentStatus: String(row.employment_status ?? "active"),
    employmentType: String(row.employment_type ?? "clt"),
  }));
  const floor = await d1.prepare("SELECT salary_floor_cents FROM fdp_company_payroll_settings WHERE workspace_id = ? AND company_id = ?")
    .bind(workspaceId, companyId).first<{ salary_floor_cents: number | string }>();
  const salaryFloorCents = Number(floor?.salary_floor_cents ?? 0);

  const remunerationRows = await d1.prepare(`SELECT r.* FROM fdp_employee_remuneration r JOIN fdp_employees e ON e.workspace_id = r.workspace_id AND e.id = r.employee_id
      WHERE r.workspace_id = ? AND e.company_id = ?`).bind(workspaceId, companyId).all<Record<string, unknown>>();
  const remunerations = new Map<string, Remuneration[]>();
  for (const row of remunerationRows.results ?? []) {
    const list = remunerations.get(String(row.employee_id)) ?? [];
    list.push(remunerationFromRow(row));
    remunerations.set(String(row.employee_id), list);
  }

  const sheetRows = await d1.prepare(`SELECT s.id, s.employee_id, s.status, ev.event_code, ev.minutes FROM fdp_time_sheets s
      LEFT JOIN fdp_time_sheet_events ev ON ev.workspace_id = s.workspace_id AND ev.time_sheet_id = s.id
      WHERE s.workspace_id = ? AND s.company_id = ? AND s.payroll_cycle_id = ?`).bind(workspaceId, companyId, cycle.id).all<Record<string, unknown>>();
  const sheets = new Map<string, TimeInput>();
  for (const row of sheetRows.results ?? []) {
    const sheet = sheets.get(String(row.employee_id)) ?? { sheetId: String(row.id), status: String(row.status), events: {} };
    if (row.event_code) sheet.events[String(row.event_code)] = (sheet.events[String(row.event_code)] ?? 0) + Number(row.minutes ?? 0);
    sheets.set(String(row.employee_id), sheet);
  }

  // Parcelas de Adiantamentos e Descontos com destino folha, da competência,
  // de lançamentos aprovados ou ativos — só o que ainda falta descontar.
  const installmentRows = await d1.prepare(`SELECT i.id, i.entry_id, i.planned_amount, i.discounted_amount, e.employee_id, e.category, e.title
      FROM fdp_ledger_installments i JOIN fdp_ledger_entries e ON e.workspace_id = i.workspace_id AND e.id = i.entry_id
      WHERE i.workspace_id = ? AND i.company_id = ? AND i.competence = ? AND i.status IN ('scheduled', 'partially_discounted')
        AND e.settlement_target = 'payroll' AND e.status IN ('approved', 'active') AND e.employee_id IS NOT NULL`)
    .bind(workspaceId, companyId, competence).all<Record<string, unknown>>();
  const installments = new Map<string, InstallmentInput[]>();
  for (const row of installmentRows.results ?? []) {
    const list = installments.get(String(row.employee_id)) ?? [];
    const category = ledgerCategoryLabels[String(row.category) as LedgerCategory] ?? "Desconto";
    list.push({ id: String(row.id), entryId: String(row.entry_id), label: `${category}: ${String(row.title)}`.slice(0, 80), amountCents: cents(row.planned_amount) - cents(row.discounted_amount) });
    installments.set(String(row.employee_id), list);
  }

  // Retroativos abertos de competências anteriores: diferença entre o salário
  // de hoje para aquela competência e o que a folha fechada dela pagou.
  const retroRows = await d1.prepare(`SELECT id, employee_id, competence FROM fdp_erp_retroactive_items
      WHERE workspace_id = ? AND company_id = ? AND status = 'open' AND employee_id IS NOT NULL AND competence < ?`)
    .bind(workspaceId, companyId, competence).all<Record<string, unknown>>();
  const retro = new Map<string, RetroInput[]>();
  for (const row of retroRows.results ?? []) {
    const employeeId = String(row.employee_id);
    const paid = (await closedResultsOf(d1, workspaceId, employeeId)).find((item) => item.competence === String(row.competence));
    const now = remunerationAt(remunerations.get(employeeId) ?? [], lastDayOfCompetence(String(row.competence)));
    if (!paid || !now) continue;
    const workedDays = Number(paid.inputs.workedDays ?? 30);
    const amountCents = Math.round(((monthlySalaryOf(now) - paid.salaryCents) / 30) * workedDays);
    const list = retro.get(employeeId) ?? [];
    list.push({ itemId: String(row.id), competence: String(row.competence), amountCents });
    retro.set(employeeId, list);
  }

  const computed: Array<{ employee: RunEmployee; payroll: EmployeePayroll }> = [];
  const skipped: RunRow["skipped"] = [];
  for (const employee of employees) {
    const remuneration = remunerationAt(remunerations.get(employee.id) ?? [], monthEnd);
    const reason = eligibility(employee, competence, remuneration);
    if (reason || !remuneration) {
      skipped.push({ employeeId: employee.id, name: employee.fullName, registrationNumber: employee.registrationNumber, reason: reason ?? "" });
      continue;
    }
    computed.push({ employee, payroll: employeePayroll({
      competence, employee, remuneration, time: sheets.get(employee.id) ?? null,
      installments: installments.get(employee.id) ?? [], retroactive: retro.get(employee.id) ?? [], salaryFloorCents,
    }) });
  }

  const totals = runTotals(computed.map((item) => item.payroll));
  const runId = existing?.id ?? crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(d1.prepare(`UPDATE fdp_payroll_runs SET calculation_count = calculation_count + 1, employees_count = ?, earnings_cents = ?,
        deductions_cents = ?, net_cents = ?, fgts_cents = ?, skipped_json = ?::jsonb, calculated_by = ?, calculated_at = now(), updated_at = now()
      WHERE workspace_id = ? AND id = ? AND status = 'calculated'`)
      .bind(computed.length, totals.earnings, totals.deductions, totals.net, totals.fgts, JSON.stringify(skipped), input.userId, workspaceId, runId));
    statements.push(d1.prepare("DELETE FROM fdp_payroll_results WHERE workspace_id = ? AND run_id = ?").bind(workspaceId, runId));
  } else {
    statements.push(d1.prepare(`INSERT INTO fdp_payroll_runs (id, workspace_id, company_id, payroll_cycle_id, competence, status, employees_count,
        earnings_cents, deductions_cents, net_cents, fgts_cents, skipped_json, calculated_by)
      VALUES (?, ?, ?, ?, ?, 'calculated', ?, ?, ?, ?, ?, ?::jsonb, ?)`)
      .bind(runId, workspaceId, companyId, cycle.id, competence, computed.length, totals.earnings, totals.deductions, totals.net, totals.fgts,
        JSON.stringify(skipped), input.userId));
  }
  for (const { employee, payroll } of computed) {
    const { result } = payroll;
    statements.push(d1.prepare(`INSERT INTO fdp_payroll_results (id, workspace_id, run_id, company_id, employee_id, competence, salary_cents,
        earnings_cents, deductions_cents, net_cents, fgts_cents, lines_json, inputs_json, notes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb)`)
      .bind(crypto.randomUUID(), workspaceId, runId, companyId, employee.id, competence, payroll.salary, result.earnings, result.deductions,
        result.net, result.fgts, JSON.stringify(result.lines), JSON.stringify(payroll.inputs), JSON.stringify(result.notes)));
  }
  statements.push(prepareAuditEvent({
    workspaceId, actorUserId: input.userId, actorEmail: input.userEmail,
    action: existing ? "payroll.run.recalculated" : "payroll.run.calculated", entityType: "payroll_run", entityId: runId,
    before: existing ? { employees: existing.employeesCount, net: existing.netCents } : null,
    after: { competence, employees: computed.length, skipped: skipped.length, ...totals },
    metadata: { scope: "company", companyId }, requestId: input.requestId,
  }));
  await d1.batch(statements);
  return runId;
}

/**
 * Fecha a folha: o resultado não muda mais, e os retroativos que entraram
 * como diferença saem da lista do ERP como lançados nesta folha.
 */
export async function closeRun(d1: SqlDatabase, input: {
  workspaceId: string; runId: string; userId: string; userEmail: string; requestId: string | null;
}) {
  const row = await d1.prepare("SELECT * FROM fdp_payroll_runs WHERE workspace_id = ? AND id = ?").bind(input.workspaceId, input.runId).first<Record<string, unknown>>();
  if (!row) throw ApiError.notFound("Folha não encontrada.", "PAYROLL_RUN_NOT_FOUND");
  const run = runFromRow(row);
  if (run.status === "closed") throw ApiError.badRequest("A folha já está fechada.", "PAYROLL_RUN_CLOSED");
  const results = await runResults(d1, input.workspaceId, run.id);
  const retroIds = results.flatMap((result) => (result.inputs.retroactive as string[] | undefined) ?? []);
  const statements: D1PreparedStatement[] = [
    d1.prepare(`UPDATE fdp_payroll_runs SET status = 'closed', closed_by = ?, closed_at = now(), updated_at = now()
      WHERE workspace_id = ? AND id = ? AND status = 'calculated'`).bind(input.userId, input.workspaceId, run.id),
  ];
  for (const id of retroIds) {
    statements.push(d1.prepare(`UPDATE fdp_erp_retroactive_items SET status = 'posted', resolution = ?, resolved_by = ?, resolved_at = now(), updated_at = now()
      WHERE workspace_id = ? AND id = ? AND status = 'open'`)
      .bind(`Diferença lançada na folha ${run.competence} do ERP DP`, input.userId, input.workspaceId, id));
  }
  statements.push(prepareAuditEvent({
    workspaceId: input.workspaceId, actorUserId: input.userId, actorEmail: input.userEmail,
    action: "payroll.run.closed", entityType: "payroll_run", entityId: run.id,
    before: { status: run.status }, after: { status: "closed", retroactivePosted: retroIds.length },
    metadata: { scope: "company", companyId: run.companyId }, requestId: input.requestId,
  }));
  await d1.batch(statements);
  return { retroactivePosted: retroIds.length };
}
