import type {
  CompanyOption, Contractor, ContractorClosing, ContractorComponent, ContractorFixedItem,
  ContractorMonthlyEntry,
  ContractorOverview, ContractorPaymentDetail, CycleOption,
  InvoiceLimitPolicy, PaymentPermissions, Psychologist, PsychologyAdjustment, PsychologyClosing,
  PsychologyOverview, PsychologySession, UnassignedSessions,
} from "./payments.types";

export type Row = Record<string, unknown>;

const pick = (row: Row, camel: string, snake: string) => row[camel] ?? row[snake];
const text = (input: unknown) => (input === null || input === undefined ? "" : String(input));
const number = (input: unknown) => Number(input) || 0;
const nullableNumber = (input: unknown) => (input === null || input === undefined || input === "" ? null : Number(input));
const bool = (input: unknown) => input === true || input === "true";

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!isForm && init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers,
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
  return {
    id: text(row.id), competence: text(row.competence), status: text(row.status),
    paymentDate: text(pick(row, "paymentDate", "payment_date")), closedAt: text(pick(row, "closedAt", "closed_at")),
  };
}

function normalizePermissions(row: Row): PaymentPermissions {
  const source = (row ?? {}) as Row;
  return {
    manage: bool(source.manage) || source.manage === true,
    close: source.close === true,
    reopen: source.reopen === true,
    manageLimits: source.manageLimits === true,
    exportCaju: source.exportCaju === true,
  };
}

export function normalizePsychologist(row: Row): Psychologist {
  return {
    id: text(row.id), code: text(row.code), legalName: text(pick(row, "legalName", "legal_name")),
    status: text(row.status) === "inactive" ? "inactive" : "active",
    defaultSessionAmount: number(pick(row, "defaultSessionAmount", "default_session_amount")),
  };
}

export function normalizePsychologyClosing(row: Row): PsychologyClosing {
  return {
    id: text(row.id), providerId: text(pick(row, "providerId", "provider_id")),
    psychologistName: text(pick(row, "psychologistName", "psychologist_name")), competence: text(row.competence),
    entriesCount: number(pick(row, "entriesCount", "entries_count")),
    sessionsCount: number(pick(row, "sessionsCount", "sessions_count")),
    employeesCount: number(pick(row, "employeesCount", "employees_count")),
    grossAmount: number(pick(row, "grossAmount", "gross_amount")),
    adjustmentsAmount: number(pick(row, "adjustmentsAmount", "adjustments_amount")),
    netAmount: number(pick(row, "netAmount", "net_amount")),
    status: text(row.status), calcVersion: text(pick(row, "calcVersion", "calc_version")),
    closedAt: text(pick(row, "closedAt", "closed_at")),
    paymentAmount: number(pick(row, "paymentAmount", "payment_amount")),
    paymentStatus: text(pick(row, "paymentStatus", "payment_status")),
    invoiceStatus: text(pick(row, "invoiceStatus", "invoice_status")),
    scheduledDate: text(pick(row, "scheduledDate", "scheduled_date")),
    paidDate: text(pick(row, "paidDate", "paid_date")),
  };
}

export function normalizePsychologySession(row: Row): PsychologySession {
  return {
    id: text(row.id), employeeId: text(pick(row, "employeeId", "employee_id")),
    employeeName: text(pick(row, "employeeName", "employee_name")),
    registrationNumber: text(pick(row, "registrationNumber", "registration_number")),
    sessionDate: text(pick(row, "sessionDate", "session_date")),
    quantity: number(pick(row, "sessionQuantity", "session_quantity")),
    unitAmount: number(pick(row, "unitAmount", "unit_amount")),
    totalAmount: number(pick(row, "totalAmount", "total_amount")),
    status: text(row.status), origin: text(row.origin),
    administrativeNote: text(pick(row, "administrativeNote", "administrative_note")),
  };
}

export function normalizeAdjustment(row: Row): PsychologyAdjustment {
  return {
    id: text(row.id), kind: text(row.kind), amount: number(row.amount), reason: text(row.reason),
    previousAmount: number(pick(row, "previousAmount", "previous_amount")),
    newAmount: number(pick(row, "newAmount", "new_amount")),
    createdAt: text(pick(row, "createdAt", "created_at")),
  };
}

export function normalizePsychologyOverview(payload: Row): PsychologyOverview {
  return {
    module: "psychology",
    competence: text(payload.competence),
    cycle: payload.cycle ? normalizeCycle(payload.cycle as Row) : null,
    cycles: ((payload.cycles ?? []) as Row[]).map(normalizeCycle),
    closings: ((payload.closings ?? []) as Row[]).map(normalizePsychologyClosing),
    psychologists: ((payload.psychologists ?? []) as Row[]).map(normalizePsychologist),
    unassignedSessions: ((payload.unassignedSessions ?? []) as Row[]).map((row): UnassignedSessions => ({
      providerId: text(pick(row, "providerId", "provider_id")), entries: number(row.entries), total: number(row.total),
    })),
    permissions: normalizePermissions(payload.permissions as Row),
    privacyBoundary: text(payload.privacyBoundary),
  };
}

export function normalizeContractor(row: Row): Contractor {
  return {
    id: text(row.id) || text(pick(row, "providerId", "provider_id")),
    code: text(row.code), legalName: text(pick(row, "legalName", "legal_name")),
    baseAmount: number(pick(row, "baseAmount", "base_amount")),
    invoiceLimitOverride: nullableNumber(pick(row, "invoiceLimitOverride", "invoice_limit_override")),
    complementMethod: text(pick(row, "complementMethod", "complement_method")) || "none",
    contractReference: text(pick(row, "contractReference", "contract_reference")),
    status: text(row.status) === "inactive" ? "inactive" : "active",
  };
}

export function normalizeContractorClosing(row: Row): ContractorClosing {
  return {
    id: text(row.id), providerId: text(pick(row, "providerId", "provider_id")),
    contractorName: text(pick(row, "contractorName", "contractor_name")),
    contractorCode: text(pick(row, "contractorCode", "contractor_code")),
    contractReference: text(pick(row, "contractReference", "contract_reference")),
    competence: text(row.competence),
    baseAmount: number(pick(row, "baseAmount", "base_amount")),
    contractBaseAmount: number(pick(row, "contractBaseAmount", "contract_base_amount"))
      || number(pick(row, "baseAmount", "base_amount")),
    prorationDays: nullableNumber(pick(row, "prorationDays", "proration_days")),
    prorationTotalDays: nullableNumber(pick(row, "prorationTotalDays", "proration_total_days")),
    prorationEndDate: text(pick(row, "prorationEndDate", "proration_end_date")),
    creditsAmount: number(pick(row, "creditsAmount", "credits_amount")),
    debitsAmount: number(pick(row, "debitsAmount", "debits_amount")),
    netAmount: number(pick(row, "netAmount", "net_amount")),
    invoiceLimitAmount: nullableNumber(pick(row, "invoiceLimitAmount", "invoice_limit_amount")),
    invoiceLimitSource: text(pick(row, "invoiceLimitSource", "invoice_limit_source")) || "none",
    invoiceExpectedAmount: number(pick(row, "invoiceExpectedAmount", "invoice_expected_amount")),
    complementAmount: number(pick(row, "complementAmount", "complement_amount")),
    complementMethod: text(pick(row, "complementMethod", "complement_method")) || "none",
    cajuAmount: number(pick(row, "cajuAmount", "caju_amount")),
    status: text(row.status),
    invoiceNumber: text(pick(row, "invoiceNumber", "invoice_number")),
    invoiceReceivedAmount: number(pick(row, "invoiceReceivedAmount", "invoice_received_amount")),
    invoiceStatus: text(pick(row, "invoiceStatus", "invoice_status")),
    cajuStatus: text(pick(row, "cajuStatus", "caju_status")),
    cajuBatchReference: text(pick(row, "cajuBatchReference", "caju_batch_reference")),
    complementPaidAmount: number(pick(row, "complementPaidAmount", "complement_paid_amount")),
    reconciliationStatus: text(pick(row, "reconciliationStatus", "reconciliation_status")),
    reconciliationDifference: number(pick(row, "reconciliationDifference", "reconciliation_difference")),
    calcVersion: text(pick(row, "calcVersion", "calc_version")),
    closedAt: text(pick(row, "closedAt", "closed_at")),
  };
}

export function normalizeComponent(row: Row): ContractorComponent {
  return {
    id: text(row.id), providerId: text(pick(row, "providerId", "provider_id")), direction: text(row.direction),
    componentType: text(pick(row, "componentType", "component_type")), description: text(row.description),
    quantity: number(pick(row, "quantity", "component_quantity")) || 1,
    amount: number(row.amount), origin: text(row.origin),
    documentReference: text(pick(row, "documentReference", "document_reference")), status: text(row.status),
  };
}

export function normalizeFixedItem(row: Row): ContractorFixedItem {
  return {
    id: text(row.id), providerId: text(pick(row, "providerId", "provider_id")),
    contractorName: text(pick(row, "contractorName", "contractor_name")),
    direction: text(row.direction) === "credit" ? "credit" : "debit",
    componentType: text(pick(row, "componentType", "component_type")), description: text(row.description),
    amount: number(row.amount), effectiveFrom: text(pick(row, "effectiveFrom", "effective_from")),
    effectiveTo: text(pick(row, "effectiveTo", "effective_to")) || null,
    status: text(row.status), note: text(row.note),
  };
}

export function normalizeMonthlyEntry(row: Row): ContractorMonthlyEntry {
  return {
    id: text(row.id), providerId: text(pick(row, "providerId", "provider_id")),
    contractorName: text(pick(row, "contractorName", "contractor_name")),
    direction: text(row.direction) === "credit" ? "credit" : "debit",
    componentType: text(pick(row, "componentType", "component_type")),
    description: text(row.description), amount: number(row.amount),
    quantity: number(pick(row, "quantity", "component_quantity")) || 1,
    origin: text(row.origin), documentReference: text(pick(row, "documentReference", "document_reference")),
    status: text(row.status),
  };
}

export function normalizeContractorPaymentDetail(payload: Row): ContractorPaymentDetail {
  const provider = (payload.provider ?? {}) as Row;
  const rawClosing = (payload.closing ?? {}) as Row;
  return {
    closing: normalizeContractorClosing({
      ...rawClosing,
      contractorName: pick(provider, "legalName", "legal_name"),
      contractorCode: provider.code,
      contractReference: pick(provider, "contractReference", "contract_reference"),
    }),
    provider: {
      id: text(provider.id), code: text(provider.code),
      legalName: text(pick(provider, "legalName", "legal_name")),
      tradeName: text(pick(provider, "tradeName", "trade_name")),
      taxId: text(pick(provider, "taxId", "tax_id")),
      contractReference: text(pick(provider, "contractReference", "contract_reference")),
      roleTitle: text(pick(provider, "roleTitle", "role_title")),
    },
    components: ((payload.components ?? []) as Row[]).map(normalizeComponent),
    permissions: {
      manage: (payload.permissions as Row | undefined)?.manage === true,
      reopen: (payload.permissions as Row | undefined)?.reopen === true,
    },
  };
}

export function normalizeContractorOverview(payload: Row): ContractorOverview {
  const totals = (payload.totals ?? {}) as Row;
  return {
    module: "contractors",
    competence: text(payload.competence),
    cycle: payload.cycle ? normalizeCycle(payload.cycle as Row) : null,
    cycles: ((payload.cycles ?? []) as Row[]).map(normalizeCycle),
    closings: ((payload.closings ?? []) as Row[]).map(normalizeContractorClosing),
    contractors: ((payload.contractors ?? []) as Row[]).map(normalizeContractor),
    fixedItems: ((payload.fixedItems ?? []) as Row[]).map(normalizeFixedItem),
    monthlyEntries: ((payload.monthlyEntries ?? []) as Row[]).map(normalizeMonthlyEntry),
    invoiceLimitPolicies: ((payload.invoiceLimitPolicies ?? []) as Row[]).map((row): InvoiceLimitPolicy => ({
      id: text(row.id), scope: text(row.scope), companyId: text(pick(row, "companyId", "company_id")),
      providerId: text(pick(row, "providerId", "provider_id")),
      contractReference: text(pick(row, "contractReference", "contract_reference")),
      amount: number(row.amount), effectiveFrom: text(pick(row, "effectiveFrom", "effective_from")),
    })),
    totals: {
      netAmount: number(totals.netAmount), invoiceExpectedAmount: number(totals.invoiceExpectedAmount),
      complementAmount: number(totals.complementAmount), cajuAmount: number(totals.cajuAmount),
      divergentCount: number(totals.divergentCount),
    },
    permissions: normalizePermissions(payload.permissions as Row),
  };
}
