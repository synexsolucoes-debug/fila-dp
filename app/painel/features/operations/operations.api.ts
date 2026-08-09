import type {
  Approval, ClosingItem, CompanyOption, Cycle, Demand, EmployeeOption, Movement, MovementType,
  Obligation, OperationPermissions, OverviewPayload, PendingItem, ProcessDefinition, ProcessVersion,
} from "./operations.types";

type Row = Record<string, unknown>;
const value = (row: Row, camel: string, snake: string = camel) => row[camel] ?? row[snake];
const text = (input: unknown) => input == null ? "" : String(input);
const bool = (input: unknown) => input === true || input === 1 || input === "1" || input === "true";
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
  return { id: text(row.id), name: text(value(row, "tradeName", "trade_name")) || text(value(row, "legalName", "legal_name")), legalName: text(value(row, "legalName", "legal_name")), status: text(row.status) };
}
export function normalizeEmployee(row: Row): EmployeeOption {
  return { id: text(row.id), name: text(value(row, "socialName", "social_name")) || text(value(row, "fullName", "full_name")), registrationNumber: text(value(row, "registrationNumber", "registration_number")) };
}
export function normalizeCycle(row: Row): Cycle {
  const raw = text(row.status);
  const status = (["open", "pre_closing", "processing", "post_closing", "closed"].includes(raw) ? raw : "open") as Cycle["status"];
  return { id: text(row.id), companyId: text(value(row, "companyId", "company_id")), competence: text(row.competence), status, preClosingDueDate: text(value(row, "preClosingDueDate", "pre_closing_due_date")), paymentDate: text(value(row, "paymentDate", "payment_date")), postClosingDueDate: text(value(row, "postClosingDueDate", "post_closing_due_date")), closedAt: text(value(row, "closedAt", "closed_at")), notes: text(row.notes) };
}
export function normalizeDemand(row: Row): Demand {
  return { id: text(row.id), title: text(row.title), processType: text(value(row, "processType", "process_type")), priority: text(row.priority), dueAt: text(value(row, "dueAt", "due_at")), legalDueAt: text(value(row, "legalDueAt", "legal_due_at")), slaStatus: text(value(row, "slaStatus", "sla_status")), archived: bool(row.archived) };
}
export function normalizeMovement(row: Row): Movement {
  const rawType = text(value(row, "movementType", "movement_type"));
  const movementType = (["salary_change", "vacation", "leave", "termination", "transfer", "benefit_change", "registration_sync", "other"].includes(rawType) ? rawType : "other") as MovementType;
  const rawStatus = text(row.status);
  const status = (["draft", "pending_approval", "approved", "rejected", "applied", "canceled"].includes(rawStatus) ? rawStatus : "draft") as Movement["status"];
  const rawDetails = value(row, "details", "details_json");
  let details: Record<string, unknown> | undefined;
  if (rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)) details = rawDetails as Record<string, unknown>;
  else if (typeof rawDetails === "string") { try { const parsed = JSON.parse(rawDetails); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>; } catch { /* invalid legacy payload remains hidden */ } }
  return { id: text(row.id), companyId: text(value(row, "companyId", "company_id")), employeeId: text(value(row, "employeeId", "employee_id")), employeeName: text(value(row, "employeeName", "employee_name")), socialName: text(value(row, "socialName", "social_name")), payrollCycleId: text(value(row, "payrollCycleId", "payroll_cycle_id")), movementType, effectiveDate: text(value(row, "effectiveDate", "effective_date")), title: text(row.title), status, createdAt: text(value(row, "createdAt", "created_at")), updatedAt: text(value(row, "updatedAt", "updated_at")), details };
}
export function normalizeApproval(row: Row): Approval {
  const raw = text(row.status);
  return { id: text(row.id), movementId: text(value(row, "movementId", "movement_id")), sequence: number(row.sequence), approverUserId: text(value(row, "approverUserId", "approver_user_id")), status: (raw === "approved" || raw === "rejected") ? raw : "pending", decidedAt: text(value(row, "decidedAt", "decided_at")), comment: text(row.comment), movementTitle: text(value(row, "movementTitle", "movement_title")), employeeName: text(value(row, "employeeName", "employee_name")), canDecide: bool(value(row, "canDecide", "can_decide")) };
}
export function normalizeClosingItem(row: Row): ClosingItem {
  const raw = text(row.status);
  return { id: text(row.id), phase: text(row.phase) === "post_closing" ? "post_closing" : "pre_closing", category: text(row.category), title: text(row.title), status: (["pending", "in_progress", "blocked", "completed"].includes(raw) ? raw : "pending") as ClosingItem["status"], ownerUserId: text(value(row, "ownerUserId", "owner_user_id")), dueDate: text(value(row, "dueDate", "due_date")), completedAt: text(value(row, "completedAt", "completed_at")), notes: text(row.notes), position: number(row.position) };
}
export function normalizeObligation(row: Row): Obligation {
  const raw = text(row.status);
  return { id: text(row.id), obligationType: text(value(row, "obligationType", "obligation_type")), title: text(row.title), dueDate: text(value(row, "dueDate", "due_date")), status: (["open", "in_progress", "blocked", "completed"].includes(raw) ? raw : "open") as Obligation["status"], ownerUserId: text(value(row, "ownerUserId", "owner_user_id")), cardId: text(value(row, "cardId", "card_id")), notes: text(row.notes) };
}
export function normalizePending(row: Row): PendingItem {
  const severity = text(row.severity); const status = text(row.status);
  return { id: text(row.id), sourceType: text(value(row, "sourceType", "source_type")), sourceId: text(value(row, "sourceId", "source_id")), severity: (["info", "warning", "critical"].includes(severity) ? severity : "warning") as PendingItem["severity"], blocking: bool(row.blocking), title: text(row.title), dueDate: text(value(row, "dueDate", "due_date")), status: (["open", "in_progress", "resolved", "waived"].includes(status) ? status : "open") as PendingItem["status"], ownerUserId: text(value(row, "ownerUserId", "owner_user_id")), resolution: text(row.resolution) };
}
export function normalizeProcess(row: Row): ProcessDefinition {
  return { id: text(row.id), code: text(row.code), name: text(row.name), category: text(row.category), status: text(row.status), latestVersion: number(value(row, "latestVersion", "latest_version")), publishedVersion: number(value(row, "publishedVersion", "published_version")) };
}
export function normalizeVersion(row: Row): ProcessVersion {
  const raw = text(row.status); const config = value(row, "configuration", "configuration_json");
  return { id: text(row.id), definitionId: text(value(row, "definitionId", "definition_id")), version: number(row.version), status: (raw === "published" || raw === "retired") ? raw : "draft", configuration: config && typeof config === "object" ? config as Record<string, unknown> : {}, publishedAt: text(value(row, "publishedAt", "published_at")) };
}

export function normalizeOverview(payload: Row): OverviewPayload {
  const permissions = (payload.permissions && typeof payload.permissions === "object" ? payload.permissions : {}) as Row;
  return {
    competence: text(payload.competence), cycle: payload.cycle && typeof payload.cycle === "object" ? normalizeCycle(payload.cycle as Row) : null,
    cycles: Array.isArray(payload.cycles) ? payload.cycles.map((row) => normalizeCycle(row as Row)) : [], demands: Array.isArray(payload.demands) ? payload.demands.map((row) => normalizeDemand(row as Row)) : [],
    obligations: Array.isArray(payload.obligations) ? payload.obligations.map((row) => normalizeObligation(row as Row)) : [], closingItems: Array.isArray(payload.closingItems) ? payload.closingItems.map((row) => normalizeClosingItem(row as Row)) : [],
    pendingItems: Array.isArray(payload.pendingItems) ? payload.pendingItems.map((row) => normalizePending(row as Row)) : [], processes: Array.isArray(payload.processes) ? payload.processes.map((row) => normalizeProcess(row as Row)) : [],
    movements: Array.isArray(payload.movements) ? payload.movements.map((row) => normalizeMovement(row as Row)) : [], approvals: Array.isArray(payload.approvals) ? payload.approvals.map((row) => normalizeApproval(row as Row)) : [],
    approvers: Array.isArray(payload.approvers) ? payload.approvers.map((row) => ({ id: text((row as Row).id), name: text((row as Row).name), email: text((row as Row).email), role: text((row as Row).role) })) : [],
    permissions: { manageCompetences: bool(permissions.manageCompetences), transitionCompetences: bool(permissions.transitionCompetences), manageMovements: bool(permissions.manageMovements), decideApprovals: bool(permissions.decideApprovals), manageObligations: bool(permissions.manageObligations), managePending: bool(permissions.managePending), manageProcesses: bool(permissions.manageProcesses), publishProcesses: bool(permissions.publishProcesses) } as OperationPermissions,
  };
}
