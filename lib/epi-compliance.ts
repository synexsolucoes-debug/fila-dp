/**
 * Regras puras do mapa de conformidade de EPI.
 *
 * O banco informa três fatos: a lotação do colaborador, os EPIs obrigatórios
 * para aquela lotação e o saldo que continua em poder da pessoa. Esta unidade
 * transforma esses fatos em uma situação operacional única. Mantê-la pura
 * permite que dashboard, cadastro do colaborador e testes usem exatamente a
 * mesma precedência — ninguém aparece "em dia" numa tela e "sem EPI" noutra.
 */

export const epiComplianceStatuses = [
  "missing", "expired", "overdue", "due_soon", "compliant", "unconfigured",
] as const;

export type EpiComplianceStatus = typeof epiComplianceStatuses[number];

export const epiComplianceStatusLabels: Record<EpiComplianceStatus, string> = {
  missing: "EPI em falta",
  expired: "EPI ou CA vencido",
  overdue: "Troca atrasada",
  due_soon: "Troca próxima",
  compliant: "Em dia",
  unconfigured: "Sem regra definida",
};

export type EpiComplianceEmployeeInput = {
  id: string;
  companyId: string;
  name: string;
  registrationNumber: string;
  departmentId: string;
  departmentName: string;
  positionId: string;
  positionName: string;
};

export type EpiRequirementInput = {
  id: string;
  companyId: string;
  departmentId: string;
  departmentName: string;
  positionId: string;
  positionName: string;
  productId: string;
  productName: string;
  caNumber: string;
  caExpiresOn: string;
  productExpiresOn: string;
  quantity: number;
  replacementDays: number;
  warningDays: number;
};

export type EpiHoldingInput = {
  employeeId: string;
  productId: string;
  productName?: string;
  quantity: number;
  lastDeliveredOn: string;
};

export type EpiComplianceItem = {
  requirementId: string;
  productId: string;
  productName: string;
  caNumber: string;
  requiredQuantity: number;
  heldQuantity: number;
  missingQuantity: number;
  lastDeliveredOn: string;
  nextExchangeOn: string;
  expiresOn: string;
  expiryReason: "CA" | "produto" | "";
  status: Exclude<EpiComplianceStatus, "unconfigured">;
};

export type EpiEmployeeCompliance = EpiComplianceEmployeeInput & {
  status: EpiComplianceStatus;
  items: EpiComplianceItem[];
  holdings: Array<{ productId: string; productName: string; quantity: number }>;
  requiredItems: number;
  compliantItems: number;
  missingItems: number;
  expiredItems: number;
  overdueItems: number;
  dueSoonItems: number;
  nextExchangeOn: string;
};

const DAY = 86_400_000;

function asDay(value: string) {
  const time = Date.parse(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(time) ? null : time;
}

function addDays(value: string, days: number) {
  const time = asDay(value);
  if (time === null || days <= 0) return "";
  return new Date(time + days * DAY).toISOString().slice(0, 10);
}

function earlierDate(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function applies(requirement: EpiRequirementInput, employee: EpiComplianceEmployeeInput) {
  return requirement.companyId === employee.companyId
    && (!requirement.departmentId || requirement.departmentId === employee.departmentId)
    && (!requirement.positionId || requirement.positionId === employee.positionId);
}

function itemStatus(requirement: EpiRequirementInput, holding: EpiHoldingInput | undefined, today: string) {
  const heldQuantity = Math.max(Number(holding?.quantity) || 0, 0);
  const requiredQuantity = Math.max(Number(requirement.quantity) || 0, 1);
  const nextExchangeOn = holding?.lastDeliveredOn
    ? addDays(holding.lastDeliveredOn, Math.max(Number(requirement.replacementDays) || 0, 0))
    : "";
  let expiresOn = "";
  let expiryReason: EpiComplianceItem["expiryReason"] = "";
  if (requirement.caExpiresOn) { expiresOn = requirement.caExpiresOn; expiryReason = "CA"; }
  if (requirement.productExpiresOn && (!expiresOn || requirement.productExpiresOn < expiresOn)) {
    expiresOn = requirement.productExpiresOn;
    expiryReason = "produto";
  }

  let status: EpiComplianceItem["status"] = "compliant";
  if (heldQuantity < requiredQuantity) status = "missing";
  else if (expiresOn && expiresOn < today) status = "expired";
  else if (nextExchangeOn && nextExchangeOn < today) status = "overdue";
  else if (nextExchangeOn) {
    const next = asDay(nextExchangeOn);
    const base = asDay(today);
    const days = next === null || base === null ? Number.POSITIVE_INFINITY : Math.round((next - base) / DAY);
    if (days <= Math.max(Number(requirement.warningDays) || 0, 0)) status = "due_soon";
  }

  return { heldQuantity, requiredQuantity, nextExchangeOn, expiresOn, expiryReason, status };
}

const employeeStatusPriority: EpiComplianceStatus[] = [
  "missing", "expired", "overdue", "due_soon", "compliant", "unconfigured",
];

/** Calcula a situação de todos os colaboradores ativos do recorte. */
export function buildEpiCompliance(
  employees: EpiComplianceEmployeeInput[],
  requirements: EpiRequirementInput[],
  holdings: EpiHoldingInput[],
  today: string,
): EpiEmployeeCompliance[] {
  const holdingByEmployeeProduct = new Map(holdings.map((item) => [`${item.employeeId}:${item.productId}`, item]));
  const productName = new Map([
    ...requirements.map((item) => [item.productId, item.productName] as const),
    ...holdings.filter((item) => item.productName).map((item) => [item.productId, item.productName ?? ""] as const),
  ]);

  return employees.map((employee) => {
    // Uma regra específica substitui a regra ampla do mesmo produto. Sem esta
    // precedência, "todos da empresa usam capacete" + "Operação usa capacete"
    // exigiria dois capacetes da mesma pessoa. Em empate de escopo, preserva a
    // regra mais restritiva em quantidade.
    const byProduct = new Map<string, EpiRequirementInput>();
    for (const requirement of requirements.filter((item) => applies(item, employee))) {
      const current = byProduct.get(requirement.productId);
      const specificity = Number(Boolean(requirement.departmentId)) + Number(Boolean(requirement.positionId));
      const currentSpecificity = current
        ? Number(Boolean(current.departmentId)) + Number(Boolean(current.positionId))
        : -1;
      if (!current || specificity > currentSpecificity
        || (specificity === currentSpecificity && requirement.quantity > current.quantity)) {
        byProduct.set(requirement.productId, requirement);
      }
    }
    const applicable = [...byProduct.values()];
    const items = applicable.map((requirement): EpiComplianceItem => {
      const result = itemStatus(requirement, holdingByEmployeeProduct.get(`${employee.id}:${requirement.productId}`), today);
      return {
        requirementId: requirement.id,
        productId: requirement.productId,
        productName: requirement.productName,
        caNumber: requirement.caNumber,
        requiredQuantity: result.requiredQuantity,
        heldQuantity: result.heldQuantity,
        missingQuantity: Math.max(result.requiredQuantity - result.heldQuantity, 0),
        lastDeliveredOn: holdingByEmployeeProduct.get(`${employee.id}:${requirement.productId}`)?.lastDeliveredOn ?? "",
        nextExchangeOn: result.nextExchangeOn,
        expiresOn: result.expiresOn,
        expiryReason: result.expiryReason,
        status: result.status,
      };
    });
    const activeHoldings = holdings
      .filter((item) => item.employeeId === employee.id && item.quantity > 0)
      .map((item) => ({ productId: item.productId, productName: productName.get(item.productId) ?? "EPI não obrigatório", quantity: item.quantity }));
    const status = !items.length
      ? "unconfigured"
      : employeeStatusPriority.find((candidate) => items.some((item) => item.status === candidate)) ?? "compliant";
    const nextExchangeOn = items.reduce((date, item) => earlierDate(date, item.nextExchangeOn), "");

    return {
      ...employee,
      status,
      items,
      holdings: activeHoldings,
      requiredItems: items.length,
      compliantItems: items.filter((item) => item.status === "compliant").length,
      missingItems: items.filter((item) => item.status === "missing").length,
      expiredItems: items.filter((item) => item.status === "expired").length,
      overdueItems: items.filter((item) => item.status === "overdue").length,
      dueSoonItems: items.filter((item) => item.status === "due_soon").length,
      nextExchangeOn,
    };
  });
}
