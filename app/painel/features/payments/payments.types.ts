export type PaymentModule = "psychology" | "contractors";

export type CompanyOption = { id: string; name: string; legalName: string; status: string };
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
  cajuStatus: string; cajuBatchReference: string; complementPaidAmount: number;
  reconciliationStatus: string; reconciliationDifference: number; calcVersion: string; closedAt: string;
};

export type InvoiceLimitPolicy = {
  id: string; scope: string; companyId: string; providerId: string; contractReference: string; amount: number; effectiveFrom: string;
};

export type ContractorComponent = {
  id: string; providerId: string; direction: string; componentType: string; description: string;
  quantity: number; amount: number; origin: string; documentReference: string; status: string;
};

export type ContractorFixedItem = {
  id: string; providerId: string; contractorName: string; direction: "credit" | "debit";
  componentType: string; description: string; amount: number; effectiveFrom: string;
  effectiveTo: string | null; status: string; note: string;
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
  origin: string; documentReference: string; status: string;
};

export type ContractorOverview = {
  module: "contractors"; competence: string; cycle: CycleOption | null; cycles: CycleOption[];
  closings: ContractorClosing[]; contractors: Contractor[]; fixedItems: ContractorFixedItem[];
  monthlyEntries: ContractorMonthlyEntry[];
  invoiceLimitPolicies: InvoiceLimitPolicy[];
  totals: { netAmount: number; invoiceExpectedAmount: number; complementAmount: number; cajuAmount: number; divergentCount: number };
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
