import type { getD1 } from "../db";
import { ApiError } from "./api-errors.ts";
import { cleanText } from "./registrations.ts";
import {
  type HourEventCode,
  type HourEventMapping,
  type ManualHourEventInput,
  type Punch,
  type TimeDayInput,
  type TimeDayType,
  type TimeEntryOrigin,
  type TimeInconsistencyKind,
  TIME_CALC_VERSION,
  assertExportable,
  calculateTimeDay,
  calculateTimeSheet,
  planTimeExport,
  renderTimeExportCsv,
} from "./time-tracking.ts";

type Database = ReturnType<typeof getD1>;

export type TimeCycleRow = { id: string; company_id: string; competence: string; status: string };

/** Competência fechada não recebe marcação nem recálculo de ponto. */
export async function requireOpenTimeCycle(d1: Database, workspaceId: string, companyId: string, cycleId: string) {
  const cycle = await d1.prepare("SELECT id, company_id, competence, status FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND id = ?")
    .bind(workspaceId, companyId, cycleId).first<TimeCycleRow>();
  if (!cycle) throw ApiError.badRequest("Competência inválida.", "INVALID_COMPETENCE");
  if (cycle.status === "closed") throw ApiError.badRequest("A competência está fechada.", "COMPETENCE_CLOSED");
  return cycle;
}

export type TimeSheetRow = {
  id: string; company_id: string; employee_id: string; payroll_cycle_id: string; competence: string;
  status: string; worked_minutes: number; expected_minutes: number; balance_minutes: number;
  blocking_issues: number; warning_issues: number;
};

export async function findTimeSheet(d1: Database, workspaceId: string, sheetId: string) {
  const sheet = await d1.prepare(`SELECT id, company_id, employee_id, payroll_cycle_id, competence, status,
      worked_minutes, expected_minutes, balance_minutes, blocking_issues, warning_issues
    FROM fdp_time_sheets WHERE workspace_id = ? AND id = ?`).bind(workspaceId, sheetId).first<TimeSheetRow>();
  if (!sheet) throw ApiError.notFound("Folha de ponto não encontrada.", "TIME_SHEET_NOT_FOUND");
  return sheet;
}

/** Cria a folha de ponto do colaborador na competência, ou devolve a existente. */
export async function ensureTimeSheet(d1: Database, input: {
  workspaceId: string; companyId: string; employeeId: string; cycle: TimeCycleRow; userId: string;
  source?: TimeEntryOrigin;
}) {
  const existing = await d1.prepare("SELECT id, status FROM fdp_time_sheets WHERE workspace_id = ? AND employee_id = ? AND payroll_cycle_id = ?")
    .bind(input.workspaceId, input.employeeId, input.cycle.id).first<{ id: string; status: string }>();
  if (existing) return { id: existing.id, status: existing.status, created: false };

  const employee = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND id = ?")
    .bind(input.workspaceId, input.companyId, input.employeeId).first<{ id: string }>();
  if (!employee) throw ApiError.badRequest("Colaborador inválido para esta empresa.", "INVALID_TIME_EMPLOYEE");

  const id = crypto.randomUUID();
  await d1.prepare(`INSERT INTO fdp_time_sheets (id, workspace_id, company_id, employee_id, payroll_cycle_id, competence,
      status, source, calc_version, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
    .bind(id, input.workspaceId, input.companyId, input.employeeId, input.cycle.id, input.cycle.competence,
      input.source ?? "manual", TIME_CALC_VERSION, input.userId).run();
  return { id, status: "draft", created: true };
}

export type TimeEntryInput = {
  entryDate: string;
  dayType: TimeDayType;
  expectedMinutes: number | null;
  punches: readonly Punch[];
  origin?: TimeEntryOrigin;
  justification?: string;
  note?: string;
};

/**
 * Grava as marcações de um dia.
 *
 * Os minutos gravados são sempre os apurados pelo motor a partir das marcações:
 * não existe caminho para digitar "horas trabalhadas" sem as marcações que as
 * sustentam, porque o cartão de ponto é a prova, não o total.
 */
export async function saveTimeEntries(d1: Database, input: {
  workspaceId: string; companyId: string; sheetId: string; employeeId: string;
  entries: readonly TimeEntryInput[]; userId: string; today?: string;
}) {
  if (!input.entries.length) return { written: 0 };

  // Uma ida ao banco, não uma por dia.
  //
  // O laço anterior gravava linha a linha. Em produção o driver é HTTP: cada
  // `.run()` é uma requisição própria. Um mês de marcações de um colaborador
  // são 31 idas — medido com PostgreSQL local (~0,1ms de latência) o laço leva
  // 10,6ms contra 1,1ms do comando único; projetado a 25ms de ida e volta, que
  // é a ordem de grandeza do driver HTTP, são 785ms contra 26ms.
  //
  // O `ON CONFLICT` continua sendo o mesmo, por isso reenviar o mês é seguro.
  const COLUNAS = 16;
  const valores: unknown[] = [];
  for (const entry of input.entries) {
    const day = calculateTimeDay({
      entryDate: entry.entryDate,
      dayType: entry.dayType,
      expectedMinutes: entry.expectedMinutes,
      punches: entry.punches,
      justification: entry.justification,
    }, { today: input.today });
    valores.push(
      crypto.randomUUID(), input.workspaceId, input.companyId, input.sheetId, input.employeeId, entry.entryDate,
      entry.dayType, day.expectedMinutes, day.workedMinutes, day.nightMinutes, day.balanceMinutes,
      JSON.stringify(entry.punches), entry.origin ?? "manual",
      cleanText(entry.justification, 500), cleanText(entry.note, 300), input.userId,
    );
  }
  const linhas = input.entries.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)").join(", ");
  await d1.prepare(`INSERT INTO fdp_time_entries (id, workspace_id, company_id, time_sheet_id, employee_id, entry_date,
      day_type, expected_minutes, worked_minutes, night_minutes, balance_minutes, punches_json, origin, justification, note, created_by)
    VALUES ${linhas}
    ON CONFLICT (workspace_id, time_sheet_id, entry_date) DO UPDATE SET
      day_type = excluded.day_type, expected_minutes = excluded.expected_minutes, worked_minutes = excluded.worked_minutes,
      night_minutes = excluded.night_minutes, balance_minutes = excluded.balance_minutes, punches_json = excluded.punches_json,
      origin = excluded.origin, justification = excluded.justification, note = excluded.note, updated_at = now()`)
    .bind(...valores)
    .run();
  const written = valores.length / COLUNAS;
  return { written };
}

type EntryRow = {
  entry_date: string; day_type: string; expected_minutes: number; punches_json: unknown; justification: string;
};

type ManualEventRow = { event_code: string; minutes: number; justification: string };

/**
 * Reapura a folha de ponto inteira a partir das marcações gravadas.
 *
 * As inconsistências são derivadas: as que deixaram de existir somem, as novas
 * entram abertas e as que persistem preservam a decisão já registrada — resolver
 * uma inconsistência é um ato humano e não pode ser desfeito por um recálculo.
 */
export async function recalculateTimeSheet(d1: Database, workspaceId: string, sheetId: string, options: { today?: string } = {}) {
  const sheet = await findTimeSheet(d1, workspaceId, sheetId);
  const [entries, manualEvents] = await Promise.all([
    d1.prepare(`SELECT entry_date, day_type, expected_minutes, punches_json, justification
      FROM fdp_time_entries WHERE workspace_id = ? AND time_sheet_id = ? ORDER BY entry_date`)
      .bind(workspaceId, sheetId).all<EntryRow>(),
    d1.prepare("SELECT event_code, minutes, justification FROM fdp_time_sheet_events WHERE workspace_id = ? AND time_sheet_id = ? AND source = 'manual'")
      .bind(workspaceId, sheetId).all<ManualEventRow>(),
  ]);

  const days: TimeDayInput[] = entries.results.map((row) => ({
    entryDate: String(row.entry_date).slice(0, 10),
    dayType: row.day_type as TimeDayType,
    expectedMinutes: Number(row.expected_minutes),
    punches: (typeof row.punches_json === "string" ? JSON.parse(row.punches_json) : row.punches_json ?? []) as Punch[],
    justification: String(row.justification ?? ""),
  }));
  const manual: ManualHourEventInput[] = manualEvents.results.map((row) => ({
    eventCode: row.event_code as HourEventCode,
    minutes: Number(row.minutes),
    justification: String(row.justification ?? ""),
  }));

  const totals = calculateTimeSheet({ days, manualEvents: manual, rules: { today: options.today } });

  // Eventos apurados: substituídos a cada recálculo. Os manuais têm dono humano e ficam.
  await d1.prepare("DELETE FROM fdp_time_sheet_events WHERE workspace_id = ? AND time_sheet_id = ? AND source = 'computed'")
    .bind(workspaceId, sheetId).run();
  const apurados = totals.events.filter((event) => event.source === "computed");
  if (apurados.length) {
    const valores = apurados.flatMap((event) =>
      [crypto.randomUUID(), workspaceId, sheetId, event.eventCode, event.minutes, "system"]);
    await d1.prepare(`INSERT INTO fdp_time_sheet_events (id, workspace_id, time_sheet_id, event_code, minutes, source, created_by)
      VALUES ${apurados.map(() => "(?, ?, ?, ?, ?, 'computed', ?)").join(", ")}`)
      .bind(...valores).run();
  }

  const existing = await d1.prepare("SELECT id, entry_date, kind, status FROM fdp_time_inconsistencies WHERE workspace_id = ? AND time_sheet_id = ?")
    .bind(workspaceId, sheetId).all<{ id: string; entry_date: string | null; kind: string; status: string }>();
  const key = (date: string | null, kind: string) => `${date ? String(date).slice(0, 10) : ""}|${kind}`;
  const derived = new Map(totals.issues.map((issue) => [key(issue.entryDate, issue.kind), issue]));
  const known = new Map(existing.results.map((row) => [key(row.entry_date, row.kind), row]));

  // As três operações vão num lote só: `batch` executa tudo numa transação e
  // numa ida. Sequenciais eram três idas por inconsistência mudada, e uma folha
  // com problema é justamente a que tem muitas.
  const comandos = [];
  const obsoletas = [...known].filter(([issueKey]) => !derived.has(issueKey)).map(([, row]) => row.id);
  if (obsoletas.length) {
    comandos.push(d1.prepare(`DELETE FROM fdp_time_inconsistencies WHERE workspace_id = ? AND id IN (${obsoletas.map(() => "?").join(", ")})`)
      .bind(workspaceId, ...obsoletas));
  }
  for (const [issueKey, issue] of derived) {
    const existente = known.get(issueKey);
    if (existente) {
      comandos.push(d1.prepare("UPDATE fdp_time_inconsistencies SET detail = ?, severity = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
        .bind(issue.detail, issue.severity, workspaceId, existente.id));
      continue;
    }
    comandos.push(d1.prepare(`INSERT INTO fdp_time_inconsistencies (id, workspace_id, time_sheet_id, entry_date, kind, severity, detail, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`)
      .bind(crypto.randomUUID(), workspaceId, sheetId, issue.entryDate, issue.kind, issue.severity, issue.detail));
  }
  if (comandos.length) await d1.batch(comandos);

  const openIssues = await d1.prepare(`SELECT
      count(*) FILTER (WHERE severity = 'blocking' AND status = 'open')::int AS blocking,
      count(*) FILTER (WHERE severity = 'warning' AND status = 'open')::int AS warning
    FROM fdp_time_inconsistencies WHERE workspace_id = ? AND time_sheet_id = ?`)
    .bind(workspaceId, sheetId).first<{ blocking: number; warning: number }>();

  await d1.prepare(`UPDATE fdp_time_sheets SET entries_count = ?, worked_minutes = ?, expected_minutes = ?, balance_minutes = ?,
      blocking_issues = ?, warning_issues = ?, calc_version = ?, updated_at = now()
    WHERE workspace_id = ? AND id = ?`)
    .bind(totals.entriesCount, totals.workedMinutes, totals.expectedMinutes, totals.balanceMinutes,
      Number(openIssues?.blocking ?? 0), Number(openIssues?.warning ?? 0), totals.calcVersion, workspaceId, sheetId).run();

  return {
    sheet,
    totals,
    openBlockingIssues: Number(openIssues?.blocking ?? 0),
    openWarningIssues: Number(openIssues?.warning ?? 0),
  };
}

/** Mapeamentos ativos do destino, na empresa da folha (§22). */
export async function hourEventMappings(d1: Database, workspaceId: string, companyId: string, destination: string) {
  const rows = await d1.prepare(`SELECT event_code, rubric_code, target_field, unit, destination, status
    FROM fdp_hour_event_mappings WHERE workspace_id = ? AND company_id = ? AND destination = ?`)
    .bind(workspaceId, companyId, destination)
    .all<{ event_code: string; rubric_code: string; target_field: string; unit: string; destination: string; status: string }>();
  return rows.results.map((row) => ({
    eventCode: row.event_code as HourEventCode,
    rubricCode: String(row.rubric_code),
    targetField: row.target_field as HourEventMapping["targetField"],
    unit: row.unit as HourEventMapping["unit"],
    destination: String(row.destination),
    status: row.status as "active" | "inactive",
  }));
}

export type TimeExportSheet = {
  sheetId: string;
  employeeId: string;
  registrationNumber: string;
  employeeName: string;
  events: { eventCode: HourEventCode; minutes: number }[];
};

/** Folhas aprovadas da competência e seus eventos apurados — a matéria-prima da exportação. */
export async function approvedSheetsForExport(d1: Database, workspaceId: string, companyId: string, cycleId: string) {
  const sheets = await d1.prepare(`SELECT s.id, s.employee_id, e.registration_number, e.full_name
    FROM fdp_time_sheets s JOIN fdp_employees e ON e.workspace_id = s.workspace_id AND e.id = s.employee_id
    WHERE s.workspace_id = ? AND s.company_id = ? AND s.payroll_cycle_id = ? AND s.status = 'approved'
    ORDER BY e.registration_number`)
    .bind(workspaceId, companyId, cycleId)
    .all<{ id: string; employee_id: string; registration_number: string; full_name: string }>();
  if (!sheets.results.length) return [] as TimeExportSheet[];

  const events = await d1.prepare(`SELECT time_sheet_id, event_code, minutes FROM fdp_time_sheet_events
    WHERE workspace_id = ? AND time_sheet_id IN (${sheets.results.map(() => "?").join(",")}) AND minutes > 0`)
    .bind(workspaceId, ...sheets.results.map((row) => row.id))
    .all<{ time_sheet_id: string; event_code: string; minutes: number }>();

  const bySheet = new Map<string, { eventCode: HourEventCode; minutes: number }[]>();
  for (const row of events.results) {
    const list = bySheet.get(String(row.time_sheet_id)) ?? [];
    list.push({ eventCode: row.event_code as HourEventCode, minutes: Number(row.minutes) });
    bySheet.set(String(row.time_sheet_id), list);
  }

  return sheets.results.map((row) => ({
    sheetId: String(row.id),
    employeeId: String(row.employee_id),
    registrationNumber: String(row.registration_number),
    employeeName: String(row.full_name),
    events: bySheet.get(String(row.id)) ?? [],
  }));
}

export type TimeExportPreview = {
  destination: string;
  sheets: { sheetId: string; registrationNumber: string; employeeName: string; lines: ReturnType<typeof planTimeExport>["lines"] }[];
  missingMappings: HourEventCode[];
  linesCount: number;
  ready: boolean;
};

/**
 * Monta a prévia da exportação sem gravar nada.
 *
 * A tela precisa poder dizer "faltam estas rubricas" antes de o operador tentar
 * exportar — bloquear é obrigatório (§22), surpreender não é.
 */
export function previewTimeExport(input: {
  destination: string;
  sheets: readonly TimeExportSheet[];
  mappings: readonly HourEventMapping[];
}): TimeExportPreview {
  const missing = new Set<HourEventCode>();
  const sheets = input.sheets.map((sheet) => {
    const plan = planTimeExport({ events: sheet.events, mappings: input.mappings });
    for (const code of plan.missingMappings) missing.add(code);
    return { sheetId: sheet.sheetId, registrationNumber: sheet.registrationNumber, employeeName: sheet.employeeName, lines: plan.lines };
  });
  const linesCount = sheets.reduce((total, sheet) => total + sheet.lines.length, 0);
  return {
    destination: input.destination,
    sheets,
    missingMappings: [...missing],
    linesCount,
    ready: missing.size === 0 && linesCount > 0,
  };
}

async function checksumOf(payload: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Executa a exportação: recusa se faltar mapeamento, grava o lote imutável e
 * marca as folhas como exportadas apontando para o lote.
 */
export async function runTimeExport(d1: Database, input: {
  workspaceId: string; companyId: string; cycle: TimeCycleRow; destination: string; userId: string;
}) {
  const [sheets, mappings] = await Promise.all([
    approvedSheetsForExport(d1, input.workspaceId, input.companyId, input.cycle.id),
    hourEventMappings(d1, input.workspaceId, input.companyId, input.destination),
  ]);
  if (!sheets.length) throw ApiError.badRequest("Não há folha de ponto aprovada nesta competência.", "TIME_EXPORT_NO_APPROVED_SHEETS");

  const preview = previewTimeExport({ destination: input.destination, sheets, mappings });
  // Bloqueio do §22: a mensagem nomeia o evento sem mapeamento configurado.
  assertExportable({
    ready: preview.ready,
    lines: preview.sheets.flatMap((sheet) => sheet.lines),
    missingMappings: preview.missingMappings,
    ignoredZeroEvents: [],
  });

  const rows = preview.sheets.flatMap((sheet) => sheet.lines.map((line) => ({
    ...line, registrationNumber: sheet.registrationNumber, employeeName: sheet.employeeName,
  })));
  const csv = renderTimeExportCsv(rows);
  const exportId = crypto.randomUUID();
  const payload = preview.sheets.map((sheet) => ({
    sheetId: sheet.sheetId, registrationNumber: sheet.registrationNumber, lines: sheet.lines,
  }));

  await d1.prepare(`INSERT INTO fdp_time_exports (id, workspace_id, company_id, payroll_cycle_id, competence, destination,
      status, sheets_count, lines_count, checksum, payload_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?::jsonb, ?)`)
    .bind(exportId, input.workspaceId, input.companyId, input.cycle.id, input.cycle.competence, input.destination,
      preview.sheets.length, preview.linesCount, await checksumOf(csv), JSON.stringify(payload), input.userId).run();

  // Uma folha por colaborador: a exportação de uma competência inteira eram
  // tantas idas ao banco quantos colaboradores. Um comando marca todas.
  const folhas = preview.sheets.map((sheet) => sheet.sheetId);
  if (folhas.length) {
    await d1.prepare(`UPDATE fdp_time_sheets SET status = 'exported', export_id = ?, exported_at = now(), updated_at = now()
      WHERE workspace_id = ? AND status = 'approved' AND id IN (${folhas.map(() => "?").join(", ")})`)
      .bind(exportId, input.workspaceId, ...folhas).run();
  }

  return { exportId, preview, csv };
}

/** Snapshot imutável gravado na folha ao ser exportada. */
export async function timeSheetSnapshot(d1: Database, workspaceId: string, sheetId: string) {
  const [sheet, entries, events, issues] = await Promise.all([
    d1.prepare("SELECT * FROM fdp_time_sheets WHERE workspace_id = ? AND id = ?").bind(workspaceId, sheetId).first<Record<string, unknown>>(),
    d1.prepare(`SELECT entry_date, day_type, expected_minutes, worked_minutes, night_minutes, balance_minutes, punches_json
      FROM fdp_time_entries WHERE workspace_id = ? AND time_sheet_id = ? ORDER BY entry_date`).bind(workspaceId, sheetId).all<Record<string, unknown>>(),
    d1.prepare("SELECT event_code, minutes, source, justification FROM fdp_time_sheet_events WHERE workspace_id = ? AND time_sheet_id = ? ORDER BY event_code")
      .bind(workspaceId, sheetId).all<Record<string, unknown>>(),
    d1.prepare("SELECT entry_date, kind, severity, status, resolution_note FROM fdp_time_inconsistencies WHERE workspace_id = ? AND time_sheet_id = ? ORDER BY entry_date, kind")
      .bind(workspaceId, sheetId).all<Record<string, unknown>>(),
  ]);
  return {
    calcVersion: sheet ? String(sheet.calc_version) : TIME_CALC_VERSION,
    capturedAt: new Date().toISOString(),
    totals: sheet
      ? {
        entriesCount: Number(sheet.entries_count), workedMinutes: Number(sheet.worked_minutes),
        expectedMinutes: Number(sheet.expected_minutes), balanceMinutes: Number(sheet.balance_minutes),
      }
      : {},
    entries: entries.results,
    events: events.results,
    inconsistencies: issues.results,
  };
}

/** Decisão humana sobre uma inconsistência; resolver e dispensar sempre exigem nota. */
export async function decideInconsistency(d1: Database, input: {
  workspaceId: string; sheetId: string; inconsistencyId: string; status: "resolved" | "waived"; note: string; userId: string;
}) {
  if (cleanText(input.note, 500).length < 5) {
    throw ApiError.badRequest("Informe uma nota de pelo menos 5 caracteres ao tratar a inconsistência.", "TIME_RESOLUTION_NOTE_REQUIRED");
  }
  const row = await d1.prepare("SELECT id, kind, status FROM fdp_time_inconsistencies WHERE workspace_id = ? AND time_sheet_id = ? AND id = ?")
    .bind(input.workspaceId, input.sheetId, input.inconsistencyId).first<{ id: string; kind: string; status: string }>();
  if (!row) throw ApiError.notFound("Inconsistência não encontrada.", "TIME_INCONSISTENCY_NOT_FOUND");
  await d1.prepare(`UPDATE fdp_time_inconsistencies SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = now(), updated_at = now()
    WHERE workspace_id = ? AND id = ?`)
    .bind(input.status, cleanText(input.note, 500), input.userId, input.workspaceId, input.inconsistencyId).run();
  return { id: input.inconsistencyId, kind: row.kind as TimeInconsistencyKind, status: input.status };
}
