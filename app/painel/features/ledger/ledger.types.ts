import type {
  LedgerAdvanceMode, LedgerCategory, LedgerEntryStatus, LedgerInstallmentStatus,
  LedgerModality, LedgerSettlementTarget,
} from "@/lib/payroll-ledger";

/**
 * Permissões que a tela recebe do servidor.
 *
 * Elas decidem quais botões existem, nunca o que é permitido: cada rota confere
 * a própria capacidade. Esconder botão é cortesia com quem usa, não proteção.
 */
export type LedgerPermissions = {
  read: boolean;
  request: boolean;
  manage: boolean;
  approve: boolean;
  pay: boolean;
  confirm: boolean;
  reverse: boolean;
  override: boolean;
  reschedule: boolean;
  import: boolean;
  export: boolean;
  close: boolean;
  reopen: boolean;
};

export type LedgerCompanyOption = {
  id: string;
  name: string;
  taxId: string;
  status: "active" | "inactive";
};

export type LedgerCompetenceOption = {
  id: string;
  companyId: string;
  competence: string;
  status: string;
};

export type LedgerAreaOption = { id: string; name: string; code: string };

export type LedgerSummary = {
  entries: number;
  awaitingApproval: number;
  plannedTotal: number;
  discountedTotal: number;
  remainingTotal: number;
};

export type LedgerOverview = {
  permissions: LedgerPermissions;
  companies: LedgerCompanyOption[];
  competences: LedgerCompetenceOption[];
  areas: LedgerAreaOption[];
  summary: LedgerSummary;
};

export type LedgerEntry = {
  id: string;
  companyId: string;
  companyName: string;
  employeeId: string;
  employeeName: string;
  providerId: string;
  providerName: string;
  registrationNumber: string;
  employmentType: string;
  employmentStatus: string;
  terminationDate: string;
  departmentId: string;
  departmentLabel: string;
  unitLabel: string;
  operationLabel: string;
  requesterAreaId: string;
  requesterAreaName: string;
  category: LedgerCategory;
  title: string;
  description: string;
  reason: string;
  occurredOn: string;
  requestedOn: string;
  requestedBy: string;
  responsibleUserId: string;
  /** Nulo no recorrente: não existe total quando não existe prazo. */
  totalAmount: number | null;
  modality: LedgerModality;
  installmentCount: number | null;
  firstCompetence: string;
  expectedEndCompetence: string;
  recurrenceEndCompetence: string;
  settlementTarget: LedgerSettlementTarget;
  status: LedgerEntryStatus;
  movementId: string;
  originType: string;
  originId: string;
  parentEntryId: string;
  details: Record<string, unknown>;
  approvalNote: string;
  approvedBy: string;
  approvedAt: string;
  canceledReason: string;
  plannedAmount: number;
  discountedAmount: number;
  remainingAmount: number;
  openInstallments: number;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type LedgerInstallment = {
  id: string;
  entryId: string;
  entryTitle: string;
  category: string;
  companyId: string;
  companyName: string;
  employeeId: string;
  employeeName: string;
  providerName: string;
  departmentLabel: string;
  unitLabel: string;
  number: number;
  totalCount: number | null;
  competence: string;
  plannedAmount: number;
  discountedAmount: number;
  remainingAmount: number;
  status: LedgerInstallmentStatus;
  batchId: string;
  note: string;
  rescheduledToCompetence: string;
  settlementTarget: string;
  entryStatus: string;
  version: number;
};

export type LedgerConfirmation = {
  id: string;
  installmentId: string;
  competence: string;
  amount: number;
  kind: "confirmation" | "reversal" | "authorized_override";
  source: string;
  reference: string;
  justification: string;
  reversesConfirmationId: string;
  confirmedBy: string;
  confirmedByName: string;
  confirmedAt: string;
};

export type LedgerDocument = {
  id: string;
  documentKind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
};

export type LedgerEvent = {
  id: string;
  installmentId: string;
  eventType: string;
  summary: string;
  actorUserId: string;
  actorName: string;
  createdAt: string;
};

export type LedgerEntryDetail = {
  entry: LedgerEntry;
  installments: LedgerInstallment[];
  confirmations: LedgerConfirmation[];
  documents: LedgerDocument[];
  events: LedgerEvent[];
};

/** O que o formulário manda. Dinheiro vai como texto: o campo é digitado. */
export type LedgerEntryDraft = {
  companyId: string;
  subjectKind: "employee" | "provider";
  employeeId: string;
  providerId: string;
  category: LedgerCategory;
  title: string;
  description: string;
  reason: string;
  occurredOn: string;
  requestedOn: string;
  unitLabel: string;
  operationLabel: string;
  requesterAreaId: string;
  modality: LedgerModality;
  totalAmount: string;
  installmentCount: string;
  firstCompetence: string;
  recurrenceEndCompetence: string;
  details: Record<string, string>;
};

export type LedgerAdvanceDraft = {
  mode: LedgerAdvanceMode;
  fixedAmount: string;
  percentage: string;
  salaryBaseAmount: string;
  effectiveFromCompetence: string;
  endCompetence: string;
  note: string;
};

export type LedgerPersonOption = {
  id: string;
  name: string;
  registrationNumber: string;
  departmentName: string;
  employmentStatus: string;
};

export type LedgerApproverOption = { id: string; name: string; email: string };

export type LedgerTab = "entries" | "installments" | "person";
