import type {
  Approval, Approver, AuxiliaryModule, AuxiliaryOverview, AuxiliaryPermissions, CompanyOption,
  CycleOption, Execution, ExecutionDetail, Provider, ProviderType, Revision,
} from "./auxiliary.types";

export type Row = Record<string, unknown>;
const value = (row: Row, camel: string, snake: string = camel) => row[camel] ?? row[snake];
const text = (input: unknown) => input == null ? "" : String(input);
const number = (input: unknown) => Number(input) || 0;
const bool = (input: unknown) => input === true || input === 1 || input === "1" || input === "true";
const object = (input: unknown): Record<string, unknown> => {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string") {
    try { const parsed = JSON.parse(input); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
    catch { return {}; }
  }
  return {};
};

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
    name: text(value(row, "tradeName", "trade_name")) || text(value(row, "legalName", "legal_name")),
    legalName: text(value(row, "legalName", "legal_name")),
    status: text(row.status),
  };
}

export function normalizeCycle(row: Row): CycleOption {
  return {
    id: text(row.id), companyId: text(value(row, "companyId", "company_id")), competence: text(row.competence),
    status: text(row.status), paymentDate: text(value(row, "paymentDate", "payment_date")), closedAt: text(value(row, "closedAt", "closed_at")),
  };
}

export function normalizeProvider(row: Row): Provider {
  const rawType = text(value(row, "providerType", "provider_type"));
  const providerType = (["benefit_operator", "psychologist", "contractor"].includes(rawType) ? rawType : "contractor") as ProviderType;
  return {
    id: text(row.id), providerType, code: text(row.code), legalName: text(value(row, "legalName", "legal_name")),
    tradeName: text(value(row, "tradeName", "trade_name")), taxId: text(value(row, "taxId", "tax_id")),
    email: text(row.email), phone: text(row.phone), status: text(row.status) === "inactive" ? "inactive" : "active",
  };
}

export function normalizeApprover(row: Row): Approver {
  return { id: text(row.id), name: text(row.name), email: text(row.email), role: text(row.role) };
}

export function normalizeApproval(row: Row): Approval {
  const rawStatus = text(row.status);
  return {
    id: text(row.id), executionId: text(value(row, "executionId", "execution_id")), revisionId: text(value(row, "revisionId", "revision_id")),
    sequence: number(row.sequence), approverUserId: text(value(row, "approverUserId", "approver_user_id")),
    approverName: text(value(row, "approverName", "approver_name")), approverEmail: text(value(row, "approverEmail", "approver_email")),
    status: (rawStatus === "approved" || rawStatus === "rejected") ? rawStatus : "pending", comment: text(row.comment),
    decidedAt: text(value(row, "decidedAt", "decided_at")), canDecide: bool(value(row, "canDecide", "can_decide")),
  };
}

export function normalizeRevision(row: Row): Revision {
  const rawStatus = text(row.status);
  const status = (["draft", "submitted", "approved", "rejected", "superseded"].includes(rawStatus) ? rawStatus : "draft") as Revision["status"];
  return {
    id: text(row.id), executionId: text(value(row, "executionId", "execution_id")), revision: number(row.revision), status,
    input: object(value(row, "input", "input_json")), output: object(value(row, "output", "output_json")),
    createdBy: text(value(row, "createdBy", "created_by")), createdAt: text(value(row, "createdAt", "created_at")),
  };
}

export function normalizeExecution(row: Row): Execution {
  const rawModule = text(value(row, "module", "module_type"));
  const moduleType = (["benefits", "psychology", "contractors"].includes(rawModule) ? rawModule : "benefits") as AuxiliaryModule;
  const rawStatus = text(row.status);
  const status = (["draft", "pending_approval", "approved", "rejected", "closed", "canceled"].includes(rawStatus) ? rawStatus : "draft") as Execution["status"];
  const rawRevision = text(value(row, "revisionStatus", "revision_status"));
  const revisionStatus = (["draft", "submitted", "approved", "rejected", "superseded"].includes(rawRevision) ? rawRevision : "draft") as Execution["revisionStatus"];
  return {
    id: text(row.id), companyId: text(value(row, "companyId", "company_id")), payrollCycleId: text(value(row, "payrollCycleId", "payroll_cycle_id")),
    providerId: text(value(row, "providerId", "provider_id")), module: moduleType, referenceCode: text(value(row, "referenceCode", "reference_code")),
    title: text(row.title), status, currentRevision: number(value(row, "currentRevision", "current_revision")), totalAmount: number(value(row, "totalAmount", "total_amount")),
    dueDate: text(value(row, "dueDate", "due_date")), ownerUserId: text(value(row, "ownerUserId", "owner_user_id")),
    providerName: text(value(row, "providerTradeName", "provider_trade_name")) || text(value(row, "providerLegalName", "provider_legal_name")),
    revisionId: text(value(row, "revisionId", "revision_id")), revisionStatus,
    input: object(value(row, "input", "input_json")), output: object(value(row, "output", "output_json")),
    approvalId: text(value(row, "approvalId", "approval_id")), approvalStatus: text(value(row, "approvalStatus", "approval_status")),
    approverUserId: text(value(row, "approverUserId", "approver_user_id")), canDecide: bool(value(row, "canDecide", "can_decide")),
    closedAt: text(value(row, "closedAt", "closed_at")), createdAt: text(value(row, "createdAt", "created_at")), updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

export function normalizeOverview(payload: Row): AuxiliaryOverview {
  const rawModule = text(payload.module);
  const moduleType = (["benefits", "psychology", "contractors"].includes(rawModule) ? rawModule : "benefits") as AuxiliaryModule;
  const permissions = object(payload.permissions);
  return {
    module: moduleType, competence: text(payload.competence), cycle: payload.cycle && typeof payload.cycle === "object" ? normalizeCycle(payload.cycle as Row) : null,
    cycles: Array.isArray(payload.cycles) ? payload.cycles.map((row) => normalizeCycle(row as Row)) : [],
    executions: Array.isArray(payload.executions) ? payload.executions.map((row) => normalizeExecution(row as Row)) : [],
    providers: Array.isArray(payload.providers) ? payload.providers.map((row) => normalizeProvider(row as Row)) : [],
    approvers: Array.isArray(payload.approvers) ? payload.approvers.map((row) => normalizeApprover(row as Row)) : [],
    permissions: {
      manage: bool(permissions.manage), requestApproval: bool(permissions.requestApproval),
      decideApproval: bool(permissions.decideApproval), close: bool(permissions.close),
    } as AuxiliaryPermissions,
    privacyBoundary: text(payload.privacyBoundary),
  };
}

export function normalizeDetail(payload: Row): ExecutionDetail {
  const execution = normalizeExecution(object(payload.execution));
  const revisions = Array.isArray(payload.revisions) ? payload.revisions.map((row) => normalizeRevision(row as Row)) : [];
  const current = revisions.find((item) => item.revision === execution.currentRevision);
  return {
    execution: current ? { ...execution, revisionId: current.id, revisionStatus: current.status, input: current.input, output: current.output } : execution,
    revisions,
    approvals: Array.isArray(payload.approvals) ? payload.approvals.map((row) => normalizeApproval(row as Row)) : [],
  };
}
