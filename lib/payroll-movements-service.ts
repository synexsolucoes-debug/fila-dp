import {
  checkMovement, sankhyaCompanyCode, sankhyaEmployeeCode,
  type MovementCheck, type MovementUnit, type PayrollCatalogEvent, type PayrollEventType,
} from "./payroll-movements.ts";

/**
 * Movimentos para o Sankhya: a leitura do banco que as rotas compartilham.
 * As regras continuam em `lib/payroll-movements.ts`.
 */

const day = (value: unknown) => value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : null;
const stamp = (value: unknown) => value ? (value instanceof Date ? value.toISOString() : String(value)) : null;

export function eventFromRow(row: Record<string, unknown>): PayrollCatalogEvent {
  const type = Number(row.event_type);
  return {
    code: Number(row.code),
    description: String(row.description ?? ""),
    unit: (["V", "H", "D", "Q"].includes(String(row.unit)) ? String(row.unit) : "V") as MovementUnit,
    eventType: (type === -1 || type === 0 ? type : 1) as PayrollEventType,
    active: String(row.status) === "active",
  };
}

export async function loadEventCatalog(d1: SqlDatabase, workspaceId: string) {
  const result = await d1.prepare(`SELECT code, description, unit, event_type, status, updated_at
    FROM fdp_payroll_event_catalog WHERE workspace_id = ? ORDER BY code`)
    .bind(workspaceId).all<Record<string, unknown>>();
  const events = new Map<number, PayrollCatalogEvent>();
  let updatedAt: string | null = null;
  for (const row of result.results) {
    events.set(Number(row.code), eventFromRow(row));
    const at = stamp(row.updated_at);
    if (at && (!updatedAt || at > updatedAt)) updatedAt = at;
  }
  return { events, updatedAt };
}

export type MovementEmployee = {
  id: string;
  name: string;
  code: string;
  registrationNumber: string;
  employmentStatus: string;
  terminationDate: string | null;
};

export async function loadCompanyEmployees(d1: SqlDatabase, workspaceId: string, companyId: string) {
  const result = await d1.prepare(`SELECT id, full_name, registration_number, external_id, employment_status, termination_date
    FROM fdp_employees WHERE workspace_id = ? AND company_id = ? ORDER BY full_name`)
    .bind(workspaceId, companyId).all<Record<string, unknown>>();
  return result.results.map((row): MovementEmployee => ({
    id: String(row.id),
    name: String(row.full_name ?? ""),
    code: sankhyaEmployeeCode({ externalId: String(row.external_id ?? ""), registrationNumber: String(row.registration_number ?? "") }),
    registrationNumber: String(row.registration_number ?? ""),
    employmentStatus: String(row.employment_status ?? "active"),
    terminationDate: day(row.termination_date),
  }));
}

export async function loadCompany(d1: SqlDatabase, workspaceId: string, companyId: string) {
  const row = await d1.prepare(`SELECT id, external_code, COALESCE(NULLIF(trade_name, ''), legal_name) AS company_name
    FROM fdp_companies WHERE workspace_id = ? AND id = ?`)
    .bind(workspaceId, companyId).first<Record<string, unknown>>();
  if (!row) return null;
  return { id: String(row.id), name: String(row.company_name ?? ""), code: sankhyaCompanyCode(String(row.external_code ?? "")) };
}

export type MovementView = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  eventCode: number;
  eventDescription: string;
  unit: MovementUnit | null;
  eventType: PayrollEventType | null;
  indexValue: number;
  amountCents: number;
  note: string;
  sequence: number;
  checks: MovementCheck[];
  exportedAt: string | null;
  /** Quem gerou a planilha que levou este lançamento. */
  exportedByName: string | null;
  createdAt: string;
};

/**
 * Lançamentos de uma empresa numa competência, já com a conferência de cada um
 * e a SEQUENCIA que sairá na planilha.
 */
export async function listCompanyMovements(d1: SqlDatabase, input: {
  workspaceId: string; companyId: string; competence: string; events: Map<number, PayrollCatalogEvent>;
}) {
  const result = await d1.prepare(`SELECT mv.id, mv.employee_id, mv.event_code, mv.index_value, mv.amount_cents, mv.note,
      mv.exported_at, to_char(mv.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, emp.full_name, emp.registration_number, emp.external_id,
      emp.employment_status, emp.termination_date, exporter.name AS exported_by_name
    FROM fdp_payroll_movement_entries mv
    JOIN fdp_employees emp ON emp.workspace_id = mv.workspace_id AND emp.id = mv.employee_id
    LEFT JOIN fdp_users exporter ON exporter.id = mv.exported_by
    WHERE mv.workspace_id = ? AND mv.company_id = ? AND mv.competence = ?
    ORDER BY emp.full_name, mv.event_code, mv.created_at, mv.id`)
    .bind(input.workspaceId, input.companyId, input.competence).all<Record<string, unknown>>();

  const counters = new Map<string, number>();
  const ordered = [...result.results].sort((left, right) =>
    String(left.employee_id).localeCompare(String(right.employee_id))
    || Number(left.event_code) - Number(right.event_code)
    || String(stamp(left.created_at)).localeCompare(String(stamp(right.created_at)))
    || String(left.id).localeCompare(String(right.id)));
  const sequences = new Map<string, number>();
  for (const row of ordered) {
    const key = `${row.employee_id}:${row.event_code}`;
    const sequence = counters.get(key) ?? 0;
    counters.set(key, sequence + 1);
    sequences.set(String(row.id), sequence);
  }

  return result.results.map((row): MovementView => {
    const event = input.events.get(Number(row.event_code)) ?? null;
    const indexValue = Number(row.index_value ?? 0);
    const amountCents = Number(row.amount_cents ?? 0);
    return {
      id: String(row.id),
      employeeId: String(row.employee_id),
      employeeName: String(row.full_name ?? ""),
      employeeCode: sankhyaEmployeeCode({ externalId: String(row.external_id ?? ""), registrationNumber: String(row.registration_number ?? "") }),
      eventCode: Number(row.event_code),
      eventDescription: event?.description ?? "",
      unit: event?.unit ?? null,
      eventType: event?.eventType ?? null,
      indexValue,
      amountCents,
      note: String(row.note ?? ""),
      sequence: sequences.get(String(row.id)) ?? 0,
      checks: checkMovement({
        competence: input.competence, indexValue, amountCents, event,
        employee: { employmentStatus: String(row.employment_status ?? "active"), terminationDate: day(row.termination_date) },
      }),
      exportedAt: stamp(row.exported_at),
      exportedByName: row.exported_by_name ? String(row.exported_by_name) : null,
      createdAt: String(stamp(row.created_at) ?? ""),
    };
  });
}
