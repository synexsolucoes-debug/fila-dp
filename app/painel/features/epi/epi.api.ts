import type {
  CompanyOption, DisposableProduct, EmployeeEpiDossier, EmployeeOption, EpiAttachment, EpiDamage,
  EpiDelivery, EpiDiscount, EpiDisposal, EpiMovement, EpiOverview, EpiProduct, EpiReturn,
} from "./epi.types";

/**
 * Normalização das respostas do módulo.
 *
 * O servidor devolve as colunas do banco em `snake_case`; a tela trabalha em
 * `camelCase`. Converter num lugar só evita o que já aconteceu noutros módulos:
 * metade dos componentes lendo `ca_number` e a outra metade `caNumber`, com um
 * campo vazio aparecendo em produção sem erro nenhum no caminho.
 */
export type Row = Record<string, unknown>;

const value = (row: Row, camel: string, snake: string) => row[camel] ?? row[snake];
const text = (input: unknown) => input == null ? "" : String(input);
const number = (input: unknown) => Number(input) || 0;
const bool = (input: unknown) => input === true || input === 1 || input === "1" || input === "true";
const day = (input: unknown) => {
  const raw = text(input);
  return raw ? raw.slice(0, 10) : "";
};

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: init?.body instanceof FormData
      ? { ...(init?.headers ?? {}) }
      : { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

const companyName = (row: Row) =>
  text(value(row, "companyTradeName", "company_trade_name")) || text(value(row, "companyLegalName", "company_legal_name"));

export function normalizeCompany(row: Row): CompanyOption {
  return {
    id: text(row.id),
    name: text(value(row, "tradeName", "trade_name")) || text(value(row, "legalName", "legal_name")),
    taxId: text(value(row, "taxId", "tax_id")),
    status: row.status === "inactive" ? "inactive" : "active",
  };
}

export function normalizeOverview(payload: Row): EpiOverview {
  const summary = (payload.summary ?? {}) as Row;
  const permissions = (payload.permissions ?? {}) as Row;
  return {
    permissions: {
      view: bool(permissions.view), create: bool(permissions.create), edit: bool(permissions.edit),
      remove: bool(permissions.remove), deliver: bool(permissions.deliver),
      receiveReturn: bool(permissions.receiveReturn), damage: bool(permissions.damage),
      dispose: bool(permissions.dispose), analyzeDiscount: bool(permissions.analyzeDiscount),
      export: bool(permissions.export), audit: bool(permissions.audit), stockAdjust: bool(permissions.stockAdjust),
    },
    companies: Array.isArray(payload.companies) ? (payload.companies as Row[]).map(normalizeCompany) : [],
    caWindowDays: number(value(payload, "caWindowDays", "ca_window_days")) || 60,
    summary: {
      stock: number(summary.stock), delivered: number(summary.delivered),
      pendingSignature: number(summary.pendingSignature), pendingSanitizing: number(summary.pendingSanitizing),
      awaitingDisposal: number(summary.awaitingDisposal), discountsInAnalysis: number(summary.discountsInAnalysis),
      caExpiring: number(summary.caExpiring), caExpired: number(summary.caExpired),
    },
  };
}

export function normalizeProduct(row: Row): EpiProduct {
  return {
    id: text(row.id),
    companyId: text(value(row, "companyId", "company_id")),
    companyName: companyName(row),
    companyTaxId: text(value(row, "companyTaxId", "company_tax_id")),
    name: text(row.name),
    epiType: text(value(row, "epiType", "epi_type")) as EpiProduct["epiType"],
    caNumber: text(value(row, "caNumber", "ca_number")),
    size: text(row.size),
    brand: text(row.brand),
    model: text(row.model),
    unitValue: number(value(row, "unitValue", "unit_value")),
    stockQuantity: number(value(row, "availableQuantity", "available_quantity") ?? value(row, "stockQuantity", "stock_quantity")),
    stockLocations: (Array.isArray(value(row, "stockLocations", "stock_locations"))
      ? value(row, "stockLocations", "stock_locations") as Row[] : []).map((item) => ({
        id: text(item.id), code: text(item.code), name: text(item.name), quantity: number(item.quantity),
      })),
    assignedQuantity: number(value(row, "assignedQuantity", "assigned_quantity")),
    registeredOn: day(value(row, "registeredOn", "registered_on")),
    status: text(row.status) as EpiProduct["status"],
    registrationReason: text(value(row, "registrationReason", "registration_reason")) as EpiProduct["registrationReason"],
    notes: text(row.notes),
    productExpiresOn: day(value(row, "productExpiresOn", "product_expires_on")),
    caExpiresOn: day(value(row, "caExpiresOn", "ca_expires_on")),
    supplier: text(row.supplier),
    internalCode: text(value(row, "internalCode", "internal_code")),
  };
}

const employeeName = (row: Row) =>
  text(value(row, "employeeSocialName", "employee_social_name")) || text(value(row, "employeeFullName", "employee_full_name"))
  || text(value(row, "employeeName", "employee_name"));

export function normalizeDelivery(row: Row): EpiDelivery {
  const quantity = number(row.quantity);
  const settled = number(value(row, "settledQuantity", "settled_quantity"));
  return {
    id: text(row.id),
    companyId: text(value(row, "companyId", "company_id")),
    companyName: companyName(row),
    productId: text(value(row, "productId", "product_id")),
    epiName: text(value(row, "epiName", "epi_name")),
    employeeId: text(value(row, "employeeId", "employee_id")),
    employeeName: employeeName(row),
    registrationNumber: text(value(row, "registrationNumber", "registration_number")),
    deliveredOn: day(value(row, "deliveredOn", "delivered_on")),
    positionName: text(value(row, "positionName", "position_name")),
    departmentName: text(value(row, "departmentName", "department_name")),
    caNumber: text(value(row, "caNumber", "ca_number")),
    size: text(row.size),
    quantity,
    settledQuantity: settled,
    outstanding: Math.max(quantity - settled, 0),
    unitValue: number(value(row, "unitValue", "unit_value")),
    deliveryReason: text(value(row, "deliveryReason", "delivery_reason")) as EpiDelivery["deliveryReason"],
    status: text(row.status) as EpiDelivery["status"],
    signatureName: text(value(row, "signatureName", "signature_name")),
    notes: text(row.notes),
    attachmentsCount: number(value(row, "attachmentsCount", "attachments_count")),
  };
}

export function normalizeReturn(row: Row): EpiReturn {
  return {
    id: text(row.id),
    companyId: text(value(row, "companyId", "company_id")),
    companyName: companyName(row),
    deliveryId: text(value(row, "deliveryId", "delivery_id")),
    productId: text(value(row, "productId", "product_id")),
    epiName: text(value(row, "epiName", "epi_name")),
    employeeId: text(value(row, "employeeId", "employee_id")),
    employeeName: employeeName(row),
    returnedOn: day(value(row, "returnedOn", "returned_on")),
    quantity: number(row.quantity),
    caNumber: text(value(row, "caNumber", "ca_number")),
    size: text(row.size),
    condition: text(value(row, "condition", "epi_condition")) as EpiReturn["condition"],
    needsSanitizing: bool(value(row, "needsSanitizing", "needs_sanitizing")),
    sanitizationStatus: text(value(row, "sanitizationStatus", "sanitization_status")),
    backToStock: bool(value(row, "backToStock", "back_to_stock")),
    sendToDisposal: bool(value(row, "sendToDisposal", "send_to_disposal")),
    generateDpDemand: bool(value(row, "generateDpDemand", "generate_dp_demand")),
    discountRequestId: text(value(row, "discountRequestId", "discount_request_id")),
    disposalId: text(value(row, "disposalId", "disposal_id")),
    notes: text(row.notes),
    attachmentsCount: number(value(row, "attachmentsCount", "attachments_count")),
  };
}

export function normalizeDamage(row: Row): EpiDamage {
  return {
    id: text(row.id),
    companyId: text(value(row, "companyId", "company_id")),
    companyName: companyName(row),
    employeeId: text(value(row, "employeeId", "employee_id")),
    employeeName: employeeName(row),
    productId: text(value(row, "productId", "product_id")),
    epiName: text(value(row, "epiName", "epi_name")),
    replacementEpiName: text(value(row, "replacementEpiName", "replacement_epi_name")),
    occurredOn: day(value(row, "occurredOn", "occurred_on")),
    quantity: number(row.quantity),
    damageReason: text(value(row, "damageReason", "damage_reason")) as EpiDamage["damageReason"],
    description: text(row.description),
    decision: text(row.decision) as EpiDamage["decision"],
    replacementQuantity: number(value(row, "replacementQuantity", "replacement_quantity")),
    discountRequestId: text(value(row, "discountRequestId", "discount_request_id")),
    disposalId: text(value(row, "disposalId", "disposal_id")),
    notes: text(row.notes),
    attachmentsCount: number(value(row, "attachmentsCount", "attachments_count")),
  };
}

export function normalizeDisposal(row: Row): EpiDisposal {
  return {
    id: text(row.id),
    companyId: text(value(row, "companyId", "company_id")),
    companyName: companyName(row),
    productId: text(value(row, "productId", "product_id")),
    epiName: text(value(row, "epiName", "epi_name")),
    employeeId: text(value(row, "employeeId", "employee_id")),
    employeeName: employeeName(row),
    disposalDate: day(value(row, "disposalDate", "disposal_date")),
    quantity: number(row.quantity),
    caNumber: text(value(row, "caNumber", "ca_number")),
    size: text(row.size),
    disposalReason: text(value(row, "disposalReason", "disposal_reason")) as EpiDisposal["disposalReason"],
    status: text(row.status) as EpiDisposal["status"],
    originType: (text(value(row, "originType", "origin_type")) || "manual") as EpiDisposal["originType"],
    confirmedAt: text(value(row, "confirmedAt", "confirmed_at")),
    notes: text(row.notes),
    attachmentsCount: number(value(row, "attachmentsCount", "attachments_count")),
  };
}

export function normalizeDisposable(row: Row): DisposableProduct {
  return {
    id: text(row.id),
    companyId: text(value(row, "companyId", "company_id")),
    companyName: companyName(row),
    name: text(row.name),
    caNumber: text(value(row, "caNumber", "ca_number")),
    size: text(row.size),
    status: text(row.status) as DisposableProduct["status"],
    stockQuantity: number(value(row, "stockQuantity", "stock_quantity")),
    unitValue: number(value(row, "unitValue", "unit_value")),
    caExpiresOn: day(value(row, "caExpiresOn", "ca_expires_on")),
  };
}

export function normalizeDiscount(row: Row): EpiDiscount {
  return {
    id: text(row.id),
    companyId: text(value(row, "companyId", "company_id")),
    companyName: companyName(row),
    companyTaxId: text(value(row, "companyTaxId", "company_tax_id")),
    employeeId: text(value(row, "employeeId", "employee_id")),
    employeeName: employeeName(row),
    registrationNumber: text(value(row, "registrationNumber", "registration_number")),
    productId: text(value(row, "productId", "product_id")),
    epiName: text(value(row, "epiName", "epi_name")),
    deliveryId: text(value(row, "deliveryId", "delivery_id")),
    cardId: text(value(row, "cardId", "card_id")),
    demandTitle: text(value(row, "demandTitle", "demand_title")),
    title: text(row.title),
    caNumber: text(value(row, "caNumber", "ca_number")),
    size: text(row.size),
    quantity: number(row.quantity),
    unitValue: number(value(row, "unitValue", "unit_value")),
    totalValue: number(value(row, "totalValue", "total_value")),
    deliveredOn: day(value(row, "deliveredOn", "delivered_on")),
    occurredOn: day(value(row, "occurredOn", "occurred_on")),
    triggerReason: text(value(row, "triggerReason", "trigger_reason")) as EpiDiscount["triggerReason"],
    reasonNote: text(value(row, "reasonNote", "reason_note")),
    status: text(row.status) as EpiDiscount["status"],
    decision: text(row.decision) as EpiDiscount["decision"],
    decidedValue: number(value(row, "decidedValue", "decided_value")),
    decisionComment: text(value(row, "decisionComment", "decision_comment")),
    competence: text(row.competence), movementId: text(value(row, "movementId", "movement_id")),
    attachmentsCount: number(value(row, "attachmentsCount", "attachments_count")),
  };
}

export function normalizeMovement(row: Row): EpiMovement {
  return {
    id: text(row.id),
    companyId: text(value(row, "companyId", "company_id")),
    movementDate: day(value(row, "movementDate", "movement_date")),
    movementType: text(value(row, "movementType", "movement_type")),
    epiName: text(value(row, "epiName", "epi_name")),
    caNumber: text(value(row, "caNumber", "ca_number")),
    size: text(row.size),
    employeeId: text(value(row, "employeeId", "employee_id")),
    employeeName: text(value(row, "employeeName", "employee_name")),
    quantity: number(row.quantity),
    stockDelta: number(value(row, "stockDelta", "stock_delta")),
    unitValue: number(value(row, "unitValue", "unit_value")),
    reason: text(value(row, "movementReason", "movement_reason")),
    condition: text(value(row, "condition", "epi_condition")),
    status: text(row.status),
    generateDpDemand: bool(value(row, "generateDpDemand", "generate_dp_demand")),
    demandId: text(value(row, "demandId", "demand_id")),
    notes: text(row.notes),
  };
}

export function normalizeAttachment(row: Row): EpiAttachment {
  return {
    id: text(row.id),
    entityType: text(value(row, "entityType", "entity_type")),
    entityId: text(value(row, "entityId", "entity_id")),
    kind: text(value(row, "attachmentKind", "attachment_kind")),
    filename: text(row.filename),
    contentType: text(value(row, "contentType", "content_type")),
    sizeBytes: number(value(row, "sizeBytes", "size_bytes")),
    createdAt: text(value(row, "createdAt", "created_at")),
  };
}

export function normalizeEmployeeOption(row: Row): EmployeeOption {
  return {
    id: text(row.id),
    name: text(value(row, "socialName", "social_name")) || text(value(row, "fullName", "full_name")),
    registrationNumber: text(value(row, "registrationNumber", "registration_number")),
    positionName: text(value(row, "positionName", "position_name")),
    departmentName: text(value(row, "departmentName", "department_name")),
  };
}

export function normalizeDossier(payload: Row): EmployeeEpiDossier {
  const employee = (payload.employee ?? {}) as Row;
  const permissions = (payload.permissions ?? {}) as Row;
  const list = <T>(key: string, map: (row: Row) => T) =>
    Array.isArray(payload[key]) ? (payload[key] as Row[]).map(map) : [];
  return {
    employeeName: text(value(employee, "socialName", "social_name")) || text(value(employee, "fullName", "full_name")),
    companyName: companyName(employee),
    permissions: {
      deliver: bool(permissions.deliver), receiveReturn: bool(permissions.receiveReturn),
      damage: bool(permissions.damage), analyzeDiscount: bool(permissions.analyzeDiscount),
    },
    deliveries: list("deliveries", normalizeDelivery),
    activeDeliveries: list("activeDeliveries", normalizeDelivery),
    returns: list("returns", normalizeReturn),
    damages: list("damages", normalizeDamage),
    disposals: list("disposals", normalizeDisposal),
    discounts: list("discounts", normalizeDiscount),
    movements: list("movements", normalizeMovement),
    attachments: list("attachments", normalizeAttachment),
  };
}

export const currency = (input: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(input || 0);

export const dateLabel = (input: string) => {
  if (!input) return "—";
  const parsed = new Date(`${input.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? input
    : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
};

export const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(Math.round(bytes / 1024), 1)} KB`;
