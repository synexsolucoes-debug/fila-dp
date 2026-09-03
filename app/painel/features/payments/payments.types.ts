export type PaymentModule = "psychology" | "contractors";

export type CompanyOption = { id: string; name: string; legalName: string; taxId: string; status: string };
export type EmployeeOption = { id: string; name: string; registrationNumber: string };
export type CycleOption = { id: string; competence: string; status: string; paymentDate: string; closedAt: string };

export type PaymentPermissions = {
  manage: boolean;
  close: boolean;
  reopen: boolean;
  manageLimits: boolean;
  exportCaju: boolean;
};

export type Psychologist = {
  id: string; code: string; legalName: string; status: string; defaultSessionAmount: number;
};

export type PsychologyClosing = {
  id: string; providerId: string; psychologistName: string; competence: string;
  entriesCount: number; sessionsCount: number; employeesCount: number;
  grossAmount: number; adjustmentsAmount: number; netAmount: number;
  status: string; calcVersion: string; closedAt: string;
  paymentAmount: number; paymentStatus: string; invoiceStatus: string; scheduledDate: string; paidDate: string;
};

export type UnassignedSessions = { providerId: string; entries: number; total: number };

export type PsychologySession = {
  id: string; employeeId: string; employeeName: string; registrationNumber: string; sessionDate: string;
  quantity: number; unitAmount: number; totalAmount: number; status: string; origin: string; administrativeNote: string;
};

export type PsychologyAdjustment = {
  id: string; kind: string; amount: number; reason: string; previousAmount: number; newAmount: number; createdAt: string;
};

export type PsychologyOverview = {
  module: "psychology"; competence: string; cycle: CycleOption | null; cycles: CycleOption[];
  closings: PsychologyClosing[]; psychologists: Psychologist[]; unassignedSessions: UnassignedSessions[];
  permissions: PaymentPermissions; privacyBoundary: string;
};

export type Contractor = {
  id: string; code: string; legalName: string; baseAmount: number; invoiceLimitOverride: number | null;
  complementMethod: string; contractReference: string; status: string;
};

export type ContractorClosing = {
  id: string; providerId: string; contractorName: string; contractorCode: string; contractReference: string; competence: string;
  baseAmount: number; contractBaseAmount: number; prorationDays: number | null; prorationTotalDays: number | null;
  prorationEndDate: string; creditsAmount: number; debitsAmount: number; netAmount: number;
  invoiceLimitAmount: number | null; invoiceLimitSource: string; invoiceExpectedAmount: number;
  complementAmount: number; complementMethod: string; cajuAmount: number;
  status: string; invoiceNumber: string; invoiceReceivedAmount: number; invoiceStatus: string;
  /** Situação da conferência da nota e o motivo do travamento, quando há um. */
  invoiceReviewStatus: string; invoicePaymentBlock: string;
  cajuStatus: string; cajuBatchReference: string; complementPaidAmount: number;
  reconciliationStatus: string; reconciliationDifference: number; calcVersion: string; closedAt: string;
};

/**
 * Um pagamento retirado da competência.
 *
 * A exclusão é lógica: a linha continua no banco, fora dos totais e dos
 * relatórios. Ela aparece nesta lista à parte para que dê para desfazer o que
 * foi excluído por engano — sem isso, excluir era uma porta de mão única.
 */
export type ContractorExcludedClosing = {
  id: string; providerId: string; contractorName: string; contractorCode: string; competence: string;
  netAmount: number; status: string; exclusionReason: string; excludedAt: string;
};

export type InvoiceLimitPolicy = {
  id: string; scope: string; companyId: string; providerId: string; contractReference: string; amount: number; effectiveFrom: string;
};

export type ContractorComponent = {
  id: string; providerId: string; direction: string; componentType: string; description: string;
  quantity: number; amount: number; origin: string; documentReference: string; status: string;
  /** Onde o desconto é abatido: `auto`, `invoice` ou `complement`. */
  settlementTarget: string;
};

export type ContractorFixedItem = {
  id: string; providerId: string; contractorName: string; direction: "credit" | "debit";
  componentType: string; description: string; amount: number; effectiveFrom: string;
  effectiveTo: string | null; status: string; note: string; settlementTarget: string;
};

export type ContractorPaymentDetail = {
  closing: ContractorClosing;
  provider: {
    id: string; code: string; legalName: string; tradeName: string; taxId: string;
    contractReference: string; roleTitle: string;
  };
  components: ContractorComponent[];
  permissions: { manage: boolean; reopen: boolean };
};

export type ContractorDocument = {
  id: string;
  closingId: string;
  documentKind: string;
  competence: string;
  invoiceNumber: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
};

/** Lançamento avulso da competência — a natureza "mensal". */
export type ContractorMonthlyEntry = {
  id: string; providerId: string; contractorName: string; direction: "credit" | "debit";
  componentType: string; description: string; amount: number; quantity: number;
  origin: string; documentReference: string; status: string; settlementTarget: string;
};

/* -------------------------------------------------------------------------- */
/* Notas fiscais                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Uma linha da aba de Notas Fiscais.
 *
 * Cada linha é um pagamento da competência — não uma nota. A distinção é o
 * ponto da tela: o pagamento sem nota é a linha que interessa a quem cobra, e
 * uma lista de notas simplesmente não o conteria.
 */
export type InvoiceRow = {
  closingId: string;
  providerId: string;
  providerName: string;
  providerTradeName: string;
  providerDocument: string;
  contractReference: string;
  companyId: string;
  companyName: string;
  companyDocument: string;
  competence: string;
  netAmount: number;
  expectedAmount: number;
  invoiceLimitAmount: number | null;
  closingStatus: string;
  reviewStatus: string;
  invoiceId: string;
  invoiceNumber: string;
  series: string;
  issueDate: string;
  issuerDocument: string;
  issuerName: string;
  informedAmount: number;
  differenceAmount: number;
  invoiceStatus: string;
  documentId: string;
  documentContentType: string;
  documentFilename: string;
  uploadedAt: string;
  uploadedByName: string;
  reviewedAt: string;
  reviewedByUserId: string;
  reviewedByName: string;
  rejectionReason: string;
  attempt: number;
  hasInvoice: boolean;
  /** Vazio quando o pagamento pode sair; o motivo por extenso quando não pode. */
  paymentBlock: string;
};

export type InvoiceSummary = {
  requiredCount: number; receivedCount: number; pendingCount: number; awaitingReviewCount: number;
  approvedCount: number; rejectedCount: number; correctionCount: number; divergentCount: number;
  readyCount: number; expectedAmount: number; approvedAmount: number; receivedAmount: number; progress: number;
};

export type InvoicePolicy = { reviewPolicy: "required" | "optional"; requiredChecks: string[] };

export type InvoicePermissions = {
  read: boolean; create: boolean; upload: boolean; update: boolean;
  review: boolean; approve: boolean; reject: boolean; replace: boolean; export: boolean;
};

export type InvoicePanel = {
  competence: string;
  cycle: CycleOption | null;
  cycles: CycleOption[];
  rows: InvoiceRow[];
  reviewers: { id: string; name: string }[];
  summary: InvoiceSummary;
  policy: InvoicePolicy;
  permissions: InvoicePermissions;
};

/** Uma versão da nota do pagamento — a vigente e as substituídas. */
export type InvoiceVersion = {
  id: string; attempt: number; invoiceNumber: string; series: string; issueDate: string;
  amount: number; expectedAmount: number; differenceAmount: number; status: string;
  documentId: string; documentFilename: string; documentContentType: string;
  rejectionReason: string; rejectionDetail: string;
  uploadedAt: string; uploadedByName: string; reviewedAt: string; reviewedByName: string;
  supersededAt: string;
};

export type InvoiceEvent = {
  id: string; invoiceId: string; action: string; summary: string; createdAt: string; actorName: string;
};

export type InvoiceDetail = {
  invoice: {
    id: string; closingId: string; providerId: string; competence: string; attempt: number;
    invoiceNumber: string; series: string; issueDate: string; issuerDocument: string; issuerName: string;
    receiverDocument: string; serviceDescription: string; amount: number; expectedAmount: number;
    differenceAmount: number; status: string; documentId: string; notes: string;
    checklist: Record<string, boolean>;
    uploadedAt: string; reviewedAt: string; reviewNote: string;
    rejectionReason: string; rejectionDetail: string; supersededAt: string;
  };
  comparison: { expectedAmount: number; informedAmount: number; difference: number; matches: boolean };
  closing: {
    id: string; status: string; competence: string; netAmount: number; baseAmount: number;
    creditsAmount: number; debitsAmount: number; expectedAmount: number;
    invoiceLimitAmount: number | null; invoiceLimitSource: string; complementAmount: number;
    reviewStatus: string; providerName: string; providerTradeName: string; providerDocument: string;
    contractReference: string; roleTitle: string; companyName: string; companyDocument: string;
  };
  document: { id: string; filename: string; contentType: string; sizeBytes: number; createdAt: string } | null;
  versions: InvoiceVersion[];
  events: InvoiceEvent[];
  policy: InvoicePolicy;
  isCurrent: boolean;
  paymentBlock: string;
  permissions: { update: boolean; review: boolean; approve: boolean; reject: boolean; replace: boolean };
};

export type ContractorOverview = {
  module: "contractors"; competence: string; cycle: CycleOption | null; cycles: CycleOption[];
  closings: ContractorClosing[]; excludedClosings: ContractorExcludedClosing[];
  contractors: Contractor[]; fixedItems: ContractorFixedItem[];
  monthlyEntries: ContractorMonthlyEntry[];
  invoiceLimitPolicies: InvoiceLimitPolicy[];
  totals: { netAmount: number; invoiceExpectedAmount: number; complementAmount: number; cajuAmount: number; divergentCount: number };
  /** Andamento das notas da competência, para o resumo da tela de pagamentos (§17). */
  invoiceSummary: InvoiceSummary;
  invoicePolicy: InvoicePolicy;
  permissions: PaymentPermissions;
};

export type PaymentDialog =
  | null
  | { kind: "psychologist" }
  | { kind: "session"; psychologists: Psychologist[]; employees: EmployeeOption[] }
  | { kind: "adjustment"; closing: PsychologyClosing }
  | { kind: "psychology-payment"; closing: PsychologyClosing }
  | { kind: "contractor" }
  | { kind: "component"; contractors: Contractor[] }
  | { kind: "fixed-item"; contractors: Contractor[]; competence: string }
  | { kind: "invoice"; closing: ContractorClosing }
  | { kind: "complement"; closing: ContractorClosing }
  | { kind: "limit"; contractors: Contractor[] }
  | { kind: "reopen"; closingId: string; module: PaymentModule };
