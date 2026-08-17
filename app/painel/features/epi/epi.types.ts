import type {
  EpiDamageDecision, EpiDamageReason, EpiDeliveryStatus, EpiDiscountDecision, EpiDiscountStatus,
  EpiDiscountTrigger, EpiDisposalReason, EpiDisposalStatus, EpiProductStatus, EpiRegistrationReason,
  EpiReturnCondition, EpiType,
} from "@/lib/epi";

export type EpiTab = "stock" | "deliveries" | "damages" | "returns" | "disposals" | "discounts" | "reports";

export type EpiPermissions = {
  view: boolean;
  create: boolean;
  edit: boolean;
  remove: boolean;
  deliver: boolean;
  receiveReturn: boolean;
  damage: boolean;
  dispose: boolean;
  analyzeDiscount: boolean;
  export: boolean;
  audit: boolean;
  stockAdjust: boolean;
};

export type EpiSummary = {
  stock: number;
  delivered: number;
  pendingSignature: number;
  pendingSanitizing: number;
  awaitingDisposal: number;
  discountsInAnalysis: number;
  caExpiring: number;
  caExpired: number;
};

export type CompanyOption = {
  id: string;
  name: string;
  taxId: string;
  status: "active" | "inactive";
};

export type EpiOverview = {
  permissions: EpiPermissions;
  companies: CompanyOption[];
  summary: EpiSummary;
  caWindowDays: number;
};

export type EpiProduct = {
  id: string;
  companyId: string;
  companyName: string;
  companyTaxId: string;
  name: string;
  epiType: EpiType;
  caNumber: string;
  size: string;
  brand: string;
  model: string;
  unitValue: number;
  stockQuantity: number;
  stockLocations: Array<{ id: string; code: string; name: string; quantity: number }>;
  assignedQuantity: number;
  registeredOn: string;
  status: EpiProductStatus;
  registrationReason: EpiRegistrationReason;
  notes: string;
  productExpiresOn: string;
  caExpiresOn: string;
  supplier: string;
  internalCode: string;
};

export type EpiDelivery = {
  id: string;
  companyId: string;
  companyName: string;
  productId: string;
  epiName: string;
  employeeId: string;
  employeeName: string;
  registrationNumber: string;
  deliveredOn: string;
  positionName: string;
  departmentName: string;
  caNumber: string;
  size: string;
  quantity: number;
  settledQuantity: number;
  outstanding: number;
  unitValue: number;
  deliveryReason: EpiRegistrationReason;
  status: EpiDeliveryStatus;
  signatureName: string;
  notes: string;
  attachmentsCount: number;
};

export type EpiReturn = {
  id: string;
  companyId: string;
  companyName: string;
  deliveryId: string;
  productId: string;
  epiName: string;
  employeeId: string;
  employeeName: string;
  returnedOn: string;
  quantity: number;
  caNumber: string;
  size: string;
  condition: EpiReturnCondition;
  needsSanitizing: boolean;
  sanitizationStatus: string;
  backToStock: boolean;
  sendToDisposal: boolean;
  generateDpDemand: boolean;
  discountRequestId: string;
  disposalId: string;
  notes: string;
  attachmentsCount: number;
};

export type EpiDamage = {
  id: string;
  companyId: string;
  companyName: string;
  employeeId: string;
  employeeName: string;
  productId: string;
  epiName: string;
  replacementEpiName: string;
  occurredOn: string;
  quantity: number;
  damageReason: EpiDamageReason;
  description: string;
  decision: EpiDamageDecision;
  replacementQuantity: number;
  discountRequestId: string;
  disposalId: string;
  notes: string;
  attachmentsCount: number;
};

export type EpiDisposal = {
  id: string;
  companyId: string;
  companyName: string;
  productId: string;
  epiName: string;
  employeeId: string;
  employeeName: string;
  disposalDate: string;
  quantity: number;
  caNumber: string;
  size: string;
  disposalReason: EpiDisposalReason;
  status: EpiDisposalStatus;
  originType: "manual" | "return" | "damage";
  confirmedAt: string;
  notes: string;
  attachmentsCount: number;
};

/** Item do estoque que já está em estado de descarte e ainda não tem registro aberto. */
export type DisposableProduct = {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  caNumber: string;
  size: string;
  status: EpiProductStatus;
  stockQuantity: number;
  unitValue: number;
  caExpiresOn: string;
};

export type EpiDiscount = {
  id: string;
  companyId: string;
  companyName: string;
  companyTaxId: string;
  employeeId: string;
  employeeName: string;
  registrationNumber: string;
  productId: string;
  epiName: string;
  deliveryId: string;
  cardId: string;
  demandTitle: string;
  title: string;
  caNumber: string;
  size: string;
  quantity: number;
  unitValue: number;
  totalValue: number;
  deliveredOn: string;
  occurredOn: string;
  triggerReason: EpiDiscountTrigger;
  reasonNote: string;
  status: EpiDiscountStatus;
  decision: EpiDiscountDecision | "";
  decidedValue: number;
  decisionComment: string;
  competence: string;
  movementId: string;
  attachmentsCount: number;
};

export type EpiMovement = {
  id: string;
  companyId: string;
  movementDate: string;
  movementType: string;
  epiName: string;
  caNumber: string;
  size: string;
  employeeId: string;
  employeeName: string;
  quantity: number;
  stockDelta: number;
  unitValue: number;
  reason: string;
  condition: string;
  status: string;
  generateDpDemand: boolean;
  demandId: string;
  notes: string;
};

export type EpiAttachment = {
  id: string;
  entityType: string;
  entityId: string;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
};

export type EmployeeOption = {
  id: string;
  name: string;
  registrationNumber: string;
  positionName: string;
  departmentName: string;
};

export type EmployeeEpiDossier = {
  employeeName: string;
  companyName: string;
  permissions: Pick<EpiPermissions, "deliver" | "receiveReturn" | "damage" | "analyzeDiscount">;
  deliveries: EpiDelivery[];
  activeDeliveries: EpiDelivery[];
  returns: EpiReturn[];
  damages: EpiDamage[];
  disposals: EpiDisposal[];
  discounts: EpiDiscount[];
  movements: EpiMovement[];
  attachments: EpiAttachment[];
};

export type ReportDefinition = {
  key: string;
  title: string;
  description: string;
  columns: Array<{ key: string; label: string }>;
};

export type ReportResult = {
  report: string;
  title: string;
  description: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  canExport: boolean;
};

/** Estado do diálogo aberto. `null` significa nenhum. */
export type EpiEditor =
  | { kind: "product"; product?: EpiProduct }
  | { kind: "delivery"; product?: EpiProduct }
  | { kind: "return"; delivery: EpiDelivery }
  | { kind: "damage"; delivery?: EpiDelivery }
  | { kind: "disposal"; product?: DisposableProduct }
  | { kind: "disposal-decision"; disposal: EpiDisposal; action: "confirm" | "cancel" | "reevaluate" }
  | { kind: "discount"; discount: EpiDiscount }
  | null;
