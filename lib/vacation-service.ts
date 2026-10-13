import { ApiError } from "./api-errors.ts";
import { vacationDaysByAbsences } from "./payroll-calc.ts";
import { mostUrgentPeriod, validateSchedule, vacationPeriods, type VacationSchedule } from "./vacation-balance.ts";

/** Controle de férias do ERP DP: leitura das programações e a gravação validada. */

const day = (value: unknown) => value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : "";

export function scheduleFromRow(row: Record<string, unknown>): VacationSchedule & { notes: string; employeeId: string } {
  return {
    id: String(row.id), employeeId: String(row.employee_id), acquisitiveStart: day(row.acquisitive_start), startDate: day(row.start_date),
    restDays: Number(row.rest_days), soldDays: Number(row.sold_days), entitledDays: Number(row.entitled_days),
    status: String(row.status) as VacationSchedule["status"], collective: Boolean(row.collective_id), notes: String(row.notes ?? ""),
  };
}

export async function schedulesOf(d1: SqlDatabase, workspaceId: string, employeeIds: readonly string[]) {
  if (!employeeIds.length) return [];
  const rows = await d1.prepare(`SELECT * FROM fdp_vacation_schedules WHERE workspace_id = ? AND employee_id IN (${employeeIds.map(() => "?").join(", ")})
      ORDER BY start_date`).bind(workspaceId, ...employeeIds).all<Record<string, unknown>>();
  return (rows.results ?? []).map(scheduleFromRow);
}

/** Valida e monta o INSERT de uma programação. Quem chama decide o lote. */
export function prepareSchedule(d1: SqlDatabase, input: {
  workspaceId: string; companyId: string; employeeId: string; admissionDate: string; today: string; userId: string;
  existing: readonly VacationSchedule[]; body: Record<string, unknown>; collectiveId?: string | null;
}) {
  const { body } = input;
  const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
  if (!isDate(body.startDate)) throw ApiError.badRequest("Informe o início das férias.", "VACATION_START_REQUIRED");
  const periods = vacationPeriods(input.admissionDate, body.startDate > input.today ? body.startDate : input.today, input.existing);
  const acquisitiveStart = isDate(body.acquisitiveStart) ? body.acquisitiveStart : (mostUrgentPeriod(periods) ?? periods[periods.length - 1])?.acquisitiveStart;
  const period = periods.find((item) => item.acquisitiveStart === acquisitiveStart) ?? null;
  const entitledDays = body.entitledDays !== undefined && body.entitledDays !== "" ? Number(body.entitledDays) : vacationDaysByAbsences(Number(body.absences ?? 0));
  if (![12, 18, 24, 30].includes(entitledDays)) throw ApiError.badRequest("Com mais de 32 faltas no período não há direito a férias (CLT art. 130).", "VACATION_NO_ENTITLEMENT");
  const restDays = Number(body.restDays);
  const soldDays = Number(body.soldDays ?? 0);
  let check: ReturnType<typeof validateSchedule>;
  try {
    check = validateSchedule({ acquisitiveStart: acquisitiveStart ?? "", startDate: body.startDate, restDays, soldDays, entitledDays, collective: Boolean(input.collectiveId) },
      period, input.existing, input.today);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code) throw ApiError.badRequest((error as Error).message, code);
    throw error;
  }
  const id = crypto.randomUUID();
  const statement = d1.prepare(`INSERT INTO fdp_vacation_schedules (id, workspace_id, company_id, employee_id, acquisitive_start, start_date, rest_days,
      sold_days, entitled_days, status, collective_id, notes, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?::date, ?::date, ?, ?, ?, 'planned', ?, ?, ?, ?)`)
    .bind(id, input.workspaceId, input.companyId, input.employeeId, acquisitiveStart, body.startDate, restDays, soldDays, entitledDays,
      input.collectiveId ?? null, String(body.notes ?? "").trim().slice(0, 500), input.userId, input.userId);
  return { id, statement, acquisitiveStart: acquisitiveStart ?? "", ...check };
}

/** Transições permitidas: programada → aprovada → gozada; cancelar enquanto não gozou. */
export const scheduleTransitions: Record<string, readonly string[]> = {
  planned: ["approved", "canceled"],
  approved: ["taken", "canceled"],
  taken: [],
  canceled: [],
};
