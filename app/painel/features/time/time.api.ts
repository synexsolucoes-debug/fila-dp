import type {
  CompanyOption, CycleOption, HourEventCatalogItem, HourEventMappingRow, TimeEventTotal, TimeExportRow,
  TimeInconsistency, TimeOverview, TimePermissions, TimeSheet,
} from "./time.types";

export type Row = Record<string, unknown>;

const pick = (row: Row, camel: string, snake: string) => row[camel] ?? row[snake];
const text = (input: unknown) => (input === null || input === undefined ? "" : String(input));
const number = (input: unknown) => Number(input) || 0;

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.message || payload.error || "Não foi possível concluir a operação.");
  return payload;
}

export function normalizeCompany(row: Row): CompanyOption {
  return {
    id: text(row.id),
    name: text(pick(row, "tradeName", "trade_name")) || text(pick(row, "legalName", "legal_name")),
    legalName: text(pick(row, "legalName", "legal_name")),
    status: text(row.status),
  };
}

function normalizeCycle(row: Row): CycleOption {
  return { id: text(row.id), competence: text(row.competence), status: text(row.status) };
}

function normalizeSheet(row: Row): TimeSheet {
  return {
    id: text(row.id),
    employeeId: text(pick(row, "employeeId", "employee_id")),
    registrationNumber: text(pick(row, "registrationNumber", "registration_number")),
    employeeName: text(pick(row, "fullName", "full_name")),
    status: text(row.status),
    source: text(row.source),
    entriesCount: number(pick(row, "entriesCount", "entries_count")),
    workedMinutes: number(pick(row, "workedMinutes", "worked_minutes")),
    expectedMinutes: number(pick(row, "expectedMinutes", "expected_minutes")),
    balanceMinutes: number(pick(row, "balanceMinutes", "balance_minutes")),
    blockingIssues: number(pick(row, "blockingIssues", "blocking_issues")),
    warningIssues: number(pick(row, "warningIssues", "warning_issues")),
    approvedAt: text(pick(row, "approvedAt", "approved_at")),
    exportedAt: text(pick(row, "exportedAt", "exported_at")),
  };
}

function normalizeInconsistency(row: Row): TimeInconsistency {
  return {
    id: text(row.id),
    sheetId: text(pick(row, "timeSheetId", "time_sheet_id")),
    entryDate: text(pick(row, "entryDate", "entry_date")).slice(0, 10),
    kind: text(row.kind),
    severity: text(row.severity) === "blocking" ? "blocking" : "warning",
    detail: text(row.detail),
    status: text(row.status),
    resolutionNote: text(pick(row, "resolutionNote", "resolution_note")),
    registrationNumber: text(pick(row, "registrationNumber", "registration_number")),
    employeeName: text(pick(row, "fullName", "full_name")),
  };
}

function normalizeMapping(row: Row): HourEventMappingRow {
  return {
    id: text(row.id),
    destination: text(row.destination),
    eventCode: text(pick(row, "eventCode", "event_code")),
    rubricCode: text(pick(row, "rubricCode", "rubric_code")),
    targetField: text(pick(row, "targetField", "target_field")),
    unit: text(row.unit),
    status: text(row.status),
    note: text(row.note),
  };
}

export function normalizeOverview(payload: Row): TimeOverview {
  const summary = (payload.summary ?? {}) as Row;
  const catalog = (payload.catalog ?? {}) as Row;
  const permissions = (payload.permissions ?? {}) as Row;
  return {
    competence: text(payload.competence),
    cycle: payload.cycle ? normalizeCycle(payload.cycle as Row) : null,
    cycles: ((payload.cycles ?? []) as Row[]).map(normalizeCycle),
    destination: text(payload.destination) || "folha",
    sheets: ((payload.sheets ?? []) as Row[]).map(normalizeSheet),
    events: ((payload.events ?? []) as Row[]).map((row): TimeEventTotal => ({
      eventCode: text(pick(row, "eventCode", "event_code")), minutes: number(row.minutes), sheets: number(row.sheets),
    })),
    inconsistencies: ((payload.inconsistencies ?? []) as Row[]).map(normalizeInconsistency),
    mappings: ((payload.mappings ?? []) as Row[]).map(normalizeMapping),
    exports: ((payload.exports ?? []) as Row[]).map((row): TimeExportRow => ({
      id: text(row.id), destination: text(row.destination), status: text(row.status),
      sheetsCount: number(pick(row, "sheetsCount", "sheets_count")),
      linesCount: number(pick(row, "linesCount", "lines_count")),
      checksum: text(row.checksum), createdAt: text(pick(row, "createdAt", "created_at")),
    })),
    summary: {
      sheets: number(summary.sheets),
      approvedSheets: number(summary.approvedSheets),
      openBlockingIssues: number(summary.openBlockingIssues),
      openWarningIssues: number(summary.openWarningIssues),
      missingMappings: ((summary.missingMappings ?? []) as unknown[]).map(text),
      exportReady: summary.exportReady === true,
    },
    catalog: {
      hourEvents: ((catalog.hourEvents ?? []) as Row[]).map((row): HourEventCatalogItem => ({
        code: text(row.code), label: text(row.label), computed: row.computed === true,
      })),
      inconsistencyLabels: (catalog.inconsistencyLabels ?? {}) as Record<string, string>,
    },
    permissions: {
      manage: permissions.manage === true,
      approve: permissions.approve === true,
      export: permissions.export === true,
      manageMappings: permissions.manageMappings === true,
    } satisfies TimePermissions,
    boundary: text(payload.boundary),
  };
}

/** Minutos como HH:MM, com sinal — o formato que o DP lê no espelho de ponto. */
export function duration(minutes: number) {
  const total = Math.abs(Math.round(minutes || 0));
  const sign = minutes < 0 ? "-" : "";
  return `${sign}${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
