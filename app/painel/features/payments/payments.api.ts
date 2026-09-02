import type {
  CompanyOption, Contractor, ContractorClosing, ContractorComponent, ContractorFixedItem,
  ContractorMonthlyEntry,
  ContractorOverview, ContractorPaymentDetail, CycleOption,
  InvoiceDetail, InvoiceEvent, InvoiceLimitPolicy, InvoicePanel, InvoicePermissions, InvoicePolicy,
  InvoiceRow, InvoiceSummary, InvoiceVersion,
  PaymentPermissions, Psychologist, PsychologyAdjustment, PsychologyClosing,
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
    invoiceReviewStatus: text(pick(row, "invoiceReviewStatus", "invoice_review_status")) || "not_required",
    invoicePaymentBlock: text(pick(row, "invoicePaymentBlock", "invoice_payment_block")),
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
    invoiceSummary: normalizeInvoiceSummary(payload.invoiceSummary as Row),
    invoicePolicy: normalizeInvoicePolicy(payload.invoicePolicy as Row),
    permissions: normalizePermissions(payload.permissions as Row),
  };
}

/* -------------------------------------------------------------------------- */
/* Notas fiscais                                                               */
/* -------------------------------------------------------------------------- */

/**
 * As respostas de nota já chegam em camelCase — o serviço monta as linhas em
 * TypeScript, não devolve a linha crua do banco. Os normalizadores continuam
 * existindo mesmo assim, e não por simetria: eles são a fronteira onde
 * `undefined` vira `""` e `null` vira `0`, e sem ela cada componente da tela
 * precisaria repetir o mesmo `?? ""` antes de qualquer comparação.
 */
export function normalizeInvoiceSummary(row: Row | undefined): InvoiceSummary {
  const source = (row ?? {}) as Row;
  return {
    requiredCount: number(source.requiredCount), receivedCount: number(source.receivedCount),
    pendingCount: number(source.pendingCount), awaitingReviewCount: number(source.awaitingReviewCount),
    approvedCount: number(source.approvedCount), rejectedCount: number(source.rejectedCount),
    correctionCount: number(source.correctionCount), divergentCount: number(source.divergentCount),
    readyCount: number(source.readyCount), expectedAmount: number(source.expectedAmount),
    approvedAmount: number(source.approvedAmount), receivedAmount: number(source.receivedAmount),
    progress: number(source.progress),
  };
}

export function normalizeInvoicePolicy(row: Row | undefined): InvoicePolicy {
  const source = (row ?? {}) as Row;
  return {
    reviewPolicy: source.reviewPolicy === "optional" ? "optional" : "required",
    requiredChecks: ((source.requiredChecks ?? []) as unknown[]).map(text),
  };
}

export function normalizeInvoiceRow(row: Row): InvoiceRow {
  return {
    closingId: text(pick(row, "closingId", "closing_id")),
    providerId: text(pick(row, "providerId", "provider_id")),
    providerName: text(pick(row, "providerName", "provider_name")),
    providerTradeName: text(pick(row, "providerTradeName", "provider_trade_name")),
    providerDocument: text(pick(row, "providerDocument", "provider_document")),
    contractReference: text(pick(row, "contractReference", "contract_reference")),
    companyId: text(pick(row, "companyId", "company_id")),
    companyName: text(pick(row, "companyName", "company_name")),
    companyDocument: text(pick(row, "companyDocument", "company_document")),
    competence: text(row.competence),
    netAmount: number(pick(row, "netAmount", "net_amount")),
    expectedAmount: number(pick(row, "expectedAmount", "expected_amount")),
    invoiceLimitAmount: nullableNumber(pick(row, "invoiceLimitAmount", "invoice_limit_amount")),
    closingStatus: text(pick(row, "closingStatus", "closing_status")),
    reviewStatus: text(pick(row, "reviewStatus", "review_status")) || "not_required",
    invoiceId: text(pick(row, "invoiceId", "invoice_id")),
    invoiceNumber: text(pick(row, "invoiceNumber", "invoice_number")),
    series: text(row.series),
    issueDate: text(pick(row, "issueDate", "issue_date")).slice(0, 10),
    issuerDocument: text(pick(row, "issuerDocument", "issuer_document")),
    issuerName: text(pick(row, "issuerName", "issuer_name")),
    informedAmount: number(pick(row, "informedAmount", "informed_amount")),
    differenceAmount: number(pick(row, "differenceAmount", "difference_amount")),
    invoiceStatus: text(pick(row, "invoiceStatus", "invoice_status")),
    documentId: text(pick(row, "documentId", "document_id")),
    documentContentType: text(pick(row, "documentContentType", "document_content_type")),
    documentFilename: text(pick(row, "documentFilename", "document_filename")),
    uploadedAt: text(pick(row, "uploadedAt", "uploaded_at")),
    uploadedByName: text(pick(row, "uploadedByName", "uploaded_by_name")),
    reviewedAt: text(pick(row, "reviewedAt", "reviewed_at")),
    reviewedByUserId: text(pick(row, "reviewedByUserId", "reviewed_by")),
    reviewedByName: text(pick(row, "reviewedByName", "reviewed_by_name")),
    rejectionReason: text(pick(row, "rejectionReason", "rejection_reason")),
    attempt: number(row.attempt),
    hasInvoice: row.hasInvoice === true || Boolean(pick(row, "invoiceId", "invoice_id")),
    paymentBlock: text(pick(row, "paymentBlock", "payment_block")),
  };
}

export function normalizeInvoicePanel(payload: Row): InvoicePanel {
  return {
    competence: text(payload.competence),
    cycle: payload.cycle ? normalizeCycle(payload.cycle as Row) : null,
    cycles: ((payload.cycles ?? []) as Row[]).map(normalizeCycle),
    rows: ((payload.rows ?? []) as Row[]).map(normalizeInvoiceRow),
    reviewers: ((payload.reviewers ?? []) as Row[]).map((row) => ({ id: text(row.id), name: text(row.name) })),
    summary: normalizeInvoiceSummary(payload.summary as Row),
    policy: normalizeInvoicePolicy(payload.policy as Row),
    permissions: normalizeInvoicePermissions(payload.permissions as Row),
  };
}

function normalizeInvoicePermissions(row: Row | undefined): InvoicePermissions {
  const source = (row ?? {}) as Row;
  const allowed = (key: string) => source[key] === true;
  return {
    read: allowed("read"), create: allowed("create"), upload: allowed("upload"), update: allowed("update"),
    review: allowed("review"), approve: allowed("approve"), reject: allowed("reject"),
    replace: allowed("replace"), export: allowed("export"),
  };
}

function normalizeInvoiceVersion(row: Row): InvoiceVersion {
  return {
    id: text(row.id), attempt: number(row.attempt),
    invoiceNumber: text(pick(row, "invoiceNumber", "invoice_number")), series: text(row.series),
    issueDate: text(pick(row, "issueDate", "issue_date")).slice(0, 10),
    amount: number(row.amount), expectedAmount: number(pick(row, "expectedAmount", "expected_amount")),
    differenceAmount: number(pick(row, "differenceAmount", "difference_amount")),
    status: text(row.status),
    documentId: text(pick(row, "documentId", "document_id")),
    documentFilename: text(pick(row, "documentFilename", "document_filename")),
    documentContentType: text(pick(row, "documentContentType", "document_content_type")),
    rejectionReason: text(pick(row, "rejectionReason", "rejection_reason")),
    rejectionDetail: text(pick(row, "rejectionDetail", "rejection_detail")),
    uploadedAt: text(pick(row, "uploadedAt", "uploaded_at")),
    uploadedByName: text(pick(row, "uploadedByName", "uploaded_by_name")),
    reviewedAt: text(pick(row, "reviewedAt", "reviewed_at")),
    reviewedByName: text(pick(row, "reviewedByName", "reviewed_by_name")),
    supersededAt: text(pick(row, "supersededAt", "superseded_at")),
  };
}

export function normalizeInvoiceDetail(payload: Row): InvoiceDetail {
  const invoice = (payload.invoice ?? {}) as Row;
  const closing = (payload.closing ?? {}) as Row;
  const comparison = (payload.comparison ?? {}) as Row;
  const document = payload.document ? (payload.document as Row) : null;
  const permissions = (payload.permissions ?? {}) as Row;
  return {
    invoice: {
      id: text(invoice.id), closingId: text(pick(invoice, "closingId", "closing_id")),
      providerId: text(pick(invoice, "providerId", "provider_id")), competence: text(invoice.competence),
      attempt: number(invoice.attempt),
      invoiceNumber: text(pick(invoice, "invoiceNumber", "invoice_number")), series: text(invoice.series),
      issueDate: text(pick(invoice, "issueDate", "issue_date")).slice(0, 10),
      issuerDocument: text(pick(invoice, "issuerDocument", "issuer_document")),
      issuerName: text(pick(invoice, "issuerName", "issuer_name")),
      receiverDocument: text(pick(invoice, "receiverDocument", "receiver_document")),
      serviceDescription: text(pick(invoice, "serviceDescription", "service_description")),
      amount: number(invoice.amount), expectedAmount: number(pick(invoice, "expectedAmount", "expected_amount")),
      differenceAmount: number(pick(invoice, "differenceAmount", "difference_amount")),
      status: text(invoice.status), documentId: text(pick(invoice, "documentId", "document_id")),
      notes: text(invoice.notes),
      checklist: (invoice.checklist ?? {}) as Record<string, boolean>,
      uploadedAt: text(pick(invoice, "uploadedAt", "uploaded_at")),
      reviewedAt: text(pick(invoice, "reviewedAt", "reviewed_at")),
      reviewNote: text(pick(invoice, "reviewNote", "review_note")),
      rejectionReason: text(pick(invoice, "rejectionReason", "rejection_reason")),
      rejectionDetail: text(pick(invoice, "rejectionDetail", "rejection_detail")),
      supersededAt: text(pick(invoice, "supersededAt", "superseded_at")),
    },
    comparison: {
      expectedAmount: number(comparison.expectedAmount), informedAmount: number(comparison.informedAmount),
      difference: number(comparison.difference), matches: comparison.matches === true,
    },
    closing: {
      id: text(closing.id), status: text(closing.status), competence: text(closing.competence),
      netAmount: number(pick(closing, "netAmount", "net_amount")),
      baseAmount: number(pick(closing, "baseAmount", "base_amount")),
      creditsAmount: number(pick(closing, "creditsAmount", "credits_amount")),
      debitsAmount: number(pick(closing, "debitsAmount", "debits_amount")),
      expectedAmount: number(pick(closing, "invoiceExpectedAmount", "invoice_expected_amount")),
      invoiceLimitAmount: nullableNumber(pick(closing, "invoiceLimitAmount", "invoice_limit_amount")),
      invoiceLimitSource: text(pick(closing, "invoiceLimitSource", "invoice_limit_source")) || "none",
      complementAmount: number(pick(closing, "complementAmount", "complement_amount")),
      reviewStatus: text(pick(closing, "invoiceReviewStatus", "invoice_review_status")) || "not_required",
      providerName: text(pick(closing, "providerName", "provider_name")),
      providerTradeName: text(pick(closing, "providerTradeName", "provider_trade_name")),
      providerDocument: text(pick(closing, "providerDocument", "provider_document")),
      contractReference: text(pick(closing, "contractReference", "contract_reference")),
      roleTitle: text(pick(closing, "roleTitle", "role_title")),
      companyName: text(pick(closing, "companyTradeName", "company_trade_name"))
        || text(pick(closing, "companyLegalName", "company_legal_name")),
      companyDocument: text(pick(closing, "companyDocument", "company_document")),
    },
    document: document
      ? {
        id: text(document.id), filename: text(document.filename),
        contentType: text(pick(document, "contentType", "content_type")),
        sizeBytes: number(pick(document, "sizeBytes", "size_bytes")),
        createdAt: text(pick(document, "createdAt", "created_at")),
      }
      : null,
    versions: ((payload.versions ?? []) as Row[]).map(normalizeInvoiceVersion),
    events: ((payload.events ?? []) as Row[]).map((row): InvoiceEvent => ({
      id: text(row.id), invoiceId: text(pick(row, "invoiceId", "invoice_id")),
      action: text(row.action), summary: text(row.summary),
      createdAt: text(pick(row, "createdAt", "created_at")),
      actorName: text(pick(row, "actorName", "actor_name")),
    })),
    policy: normalizeInvoicePolicy(payload.policy as Row),
    isCurrent: payload.isCurrent === true,
    paymentBlock: text(pick(payload, "paymentBlock", "payment_block")),
    permissions: {
      update: permissions.update === true, review: permissions.review === true,
      approve: permissions.approve === true, reject: permissions.reject === true,
      replace: permissions.replace === true,
    },
  };
}
