import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "./api-errors.ts";
import { currentVaultKey, vaultKeyByVersion } from "./integrations.ts";
import { cleanText } from "./registrations.ts";

/**
 * Controle de pagamento de psicólogos e prestadores PJ.
 *
 * Este módulo é deliberadamente puro: ele não acessa banco, sessão ou rede.
 * As regras de dinheiro ficam aqui para poderem ser versionadas e testadas
 * isoladamente, e os fechamentos guardam a versão usada no cálculo.
 */
export const PSYCHOLOGY_CALC_VERSION = "psychology-payment-1.0.0";
export const CONTRACTOR_CALC_VERSION = "contractor-payment-1.0.0";

const MAX_MONEY = 1_000_000_000;

/** Converte reais para centavos inteiros; toda a aritmética financeira acontece em centavos. */
export function toCents(value: unknown, field = "Valor") {
  const number = typeof value === "number" ? value : Number(cleanText(value, 24).replace(/\./gu, "").replace(",", "."));
  if (!Number.isFinite(number) || Math.abs(number) > MAX_MONEY) {
    throw ApiError.badRequest(`${field} inválido.`, "INVALID_MONEY");
  }
  return Math.round(number * 100);
}

export function fromCents(cents: number) {
  return Math.round(cents) / 100;
}

/** Valor monetário não negativo, usado em bases, valores unitários e limites. */
export function positiveMoney(value: unknown, field = "Valor") {
  const cents = toCents(value ?? 0, field);
  if (cents < 0) throw ApiError.badRequest(`${field} não pode ser negativo.`, "NEGATIVE_MONEY");
  return fromCents(cents);
}

export function quantity(value: unknown, field = "Quantidade", max = 10_000) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1 || number > max) {
    throw ApiError.badRequest(`${field} inválida.`, "INVALID_QUANTITY");
  }
  return number;
}

/* -------------------------------------------------------------------------- */
/* Psicólogos — controle administrativo e financeiro do pagamento de consultas */
/* -------------------------------------------------------------------------- */

/** Origem de qualquer lançamento de pagamento: digitado, importado ou vindo de conector. */
export const paymentOrigins = ["manual", "import", "integration"] as const;
export type PaymentOrigin = typeof paymentOrigins[number];
export const psychologySessionOrigins = paymentOrigins;

export const psychologySessionStatuses = ["registered", "canceled"] as const;
export const psychologyClosingStatuses = ["open", "review", "approval", "scheduled", "paid", "closed", "reopened"] as const;
export type PsychologyClosingStatus = typeof psychologyClosingStatuses[number];

export const psychologyAdjustmentKinds = ["inclusion", "cancellation", "correction", "discount", "complement"] as const;
export type PsychologyAdjustmentKind = typeof psychologyAdjustmentKinds[number];

/** Ajustes que reduzem o valor a pagar; os demais aumentam. */
const negativeAdjustmentKinds = new Set<PsychologyAdjustmentKind>(["cancellation", "discount"]);

export const psychologyPaymentMethods = ["pix", "bank_transfer", "invoice_payment", "other"] as const;
export const psychologyPaymentStatuses = ["pending", "scheduled", "paid", "canceled"] as const;
export const invoiceStatuses = ["not_required", "pending", "received", "validated", "divergent"] as const;
export type InvoiceStatus = typeof invoiceStatuses[number];

/**
 * Total de uma consulta lançada para pagamento.
 * O valor unitário é sempre o valor histórico gravado no lançamento.
 */
export function calculateSessionTotal(sessionQuantity: number, unitAmount: number) {
  return fromCents(sessionQuantity * toCents(unitAmount, "Valor unitário"));
}

export type PsychologySessionInput = {
  employeeId: string;
  quantity: number;
  unitAmount: number;
  status?: typeof psychologySessionStatuses[number];
};

export type PsychologyAdjustmentInput = {
  kind: PsychologyAdjustmentKind;
  amount: number;
};

/**
 * "Quantas consultas válidas cada psicólogo realizou nesta competência
 * e quanto devemos pagar?" — esta função responde exatamente a isso.
 */
export function calculatePsychologyClosing(input: {
  sessions: readonly PsychologySessionInput[];
  adjustments?: readonly PsychologyAdjustmentInput[];
}) {
  const active = input.sessions.filter((session) => (session.status ?? "registered") === "registered");
  const grossCents = active.reduce((total, session) => total + session.quantity * toCents(session.unitAmount, "Valor unitário"), 0);
  const adjustmentsCents = (input.adjustments ?? []).reduce((total, adjustment) => {
    const cents = Math.abs(toCents(adjustment.amount, "Valor do ajuste"));
    return total + (negativeAdjustmentKinds.has(adjustment.kind) ? -cents : cents);
  }, 0);
  const netCents = grossCents + adjustmentsCents;
  return {
    entriesCount: active.length,
    sessionsCount: active.reduce((total, session) => total + session.quantity, 0),
    employeesCount: new Set(active.map((session) => session.employeeId)).size,
    grossAmount: fromCents(grossCents),
    adjustmentsAmount: fromCents(adjustmentsCents),
    netAmount: fromCents(Math.max(netCents, 0)),
    negativeNet: netCents < 0,
    calcVersion: PSYCHOLOGY_CALC_VERSION,
  };
}

/* -------------------------------------------------------------------------- */
/* PJ — controle de pagamento, nota fiscal esperada e complemento configurado  */
/* -------------------------------------------------------------------------- */

export const invoiceLimitScopes = ["provider", "contract", "company", "workspace"] as const;
export type InvoiceLimitScope = typeof invoiceLimitScopes[number];

/** Prioridade obrigatória: prestador → contrato → empresa → workspace. */
const limitPrecedence: readonly InvoiceLimitScope[] = invoiceLimitScopes;

export type InvoiceLimitCandidate = {
  scope: InvoiceLimitScope;
  amount: number;
  policyId?: string | null;
  effectiveFrom?: string | null;
};

export type ResolvedInvoiceLimit = {
  amount: number | null;
  source: InvoiceLimitScope | "none";
  policyId: string | null;
};

/**
 * Resolve o limite da nota respeitando a prioridade do produto.
 * Não existe limite fixo em código: a ausência de política é registrada
 * explicitamente como `none` e significa "sem teto configurado".
 */
export function resolveInvoiceLimit(candidates: readonly InvoiceLimitCandidate[]): ResolvedInvoiceLimit {
  for (const scope of limitPrecedence) {
    const scoped = candidates
      .filter((candidate) => candidate.scope === scope && Number.isFinite(candidate.amount) && candidate.amount >= 0)
      .sort((left, right) => String(right.effectiveFrom ?? "").localeCompare(String(left.effectiveFrom ?? "")));
    const chosen = scoped[0];
    if (chosen) return { amount: fromCents(toCents(chosen.amount, "Limite da nota")), source: scope, policyId: chosen.policyId ?? null };
  }
  return { amount: null, source: "none", policyId: null };
}

export const contractorCreditTypes = [
  "base", "commission", "bonus", "award", "reimbursement", "additional", "positive_adjustment", "other_credit",
] as const;
export const contractorDebitTypes = [
  "health_plan", "dental_plan", "benefit", "coparticipation", "equipment", "advance", "absence", "loan", "negative_adjustment", "other_debit",
] as const;
export type ContractorComponentType = typeof contractorCreditTypes[number] | typeof contractorDebitTypes[number];

export const contractorComponentDirections = ["credit", "debit"] as const;
export type ContractorComponentDirection = typeof contractorComponentDirections[number];

export const complementMethods = ["none", "caju_saldo_livre", "other_benefit_card", "manual_transfer"] as const;
export type ComplementMethod = typeof complementMethods[number];

export const contractorClosingStatuses = [
  "open", "review", "approval", "approved", "invoice_pending", "ready_to_pay", "paid", "closed", "reopened",
] as const;
export type ContractorClosingStatus = typeof contractorClosingStatuses[number];

export const cajuStatuses = ["not_required", "pending", "approved", "sent", "processed", "error", "canceled"] as const;
export type CajuStatus = typeof cajuStatuses[number];

export const contractorComponentStatuses = ["active", "canceled"] as const;
export const reconciliationStatuses = ["pending", "reconciled", "divergent"] as const;
export type ReconciliationStatus = typeof reconciliationStatuses[number];

export function componentDirectionFor(type: ContractorComponentType): ContractorComponentDirection {
  return (contractorCreditTypes as readonly string[]).includes(type) ? "credit" : "debit";
}

export type ContractorComponentInput = {
  direction: ContractorComponentDirection;
  componentType?: ContractorComponentType;
  amount: number;
  status?: typeof contractorComponentStatuses[number];
};

export type ContractorClosingCalculation = {
  baseAmount: number;
  creditsAmount: number;
  debitsAmount: number;
  netAmount: number;
  invoiceLimitAmount: number | null;
  invoiceLimitSource: InvoiceLimitScope | "none";
  invoiceExpectedAmount: number;
  complementAmount: number;
  complementMethod: ComplementMethod;
  cajuAmount: number;
  requiresComplementMethod: boolean;
  negativeNet: boolean;
  calcVersion: string;
};

/**
 * Ordem obrigatória do cálculo PJ:
 *
 *   1. líquido devido = base + créditos - descontos
 *   2. nota fiscal    = mínimo(líquido devido, limite configurado)
 *   3. complemento    = máximo(líquido devido - nota fiscal, 0)
 *   4. Caju           = complemento, quando o meio complementar for Caju Saldo Livre
 *
 * Inverter os passos 1 e 2 produz nota e complemento errados; os testes
 * cobrem explicitamente os exemplos da especificação do produto.
 */
export function calculateContractorClosing(input: {
  baseAmount: number;
  components: readonly ContractorComponentInput[];
  invoiceLimit: ResolvedInvoiceLimit;
  complementMethod: ComplementMethod;
}): ContractorClosingCalculation {
  const baseCents = toCents(input.baseAmount, "Valor base");
  if (baseCents < 0) throw ApiError.badRequest("Valor base não pode ser negativo.", "NEGATIVE_MONEY");

  const active = input.components.filter((component) => (component.status ?? "active") === "active");
  const creditsCents = active
    .filter((component) => component.direction === "credit")
    .reduce((total, component) => total + Math.abs(toCents(component.amount, "Valor do crédito")), 0);
  const debitsCents = active
    .filter((component) => component.direction === "debit")
    .reduce((total, component) => total + Math.abs(toCents(component.amount, "Valor do desconto")), 0);

  // 1. líquido devido — créditos e descontos SEMPRE antes do limite da nota.
  const netCents = baseCents + creditsCents - debitsCents;
  const payableCents = Math.max(netCents, 0);

  // 2. nota fiscal esperada.
  const limitCents = input.invoiceLimit.amount === null ? null : toCents(input.invoiceLimit.amount, "Limite da nota");
  const invoiceCents = limitCents === null ? payableCents : Math.min(payableCents, limitCents);

  // 3. complemento e 4. Caju.
  const complementCents = Math.max(payableCents - invoiceCents, 0);
  const cajuCents = input.complementMethod === "caju_saldo_livre" ? complementCents : 0;

  return {
    baseAmount: fromCents(baseCents),
    creditsAmount: fromCents(creditsCents),
    debitsAmount: fromCents(debitsCents),
    netAmount: fromCents(payableCents),
    invoiceLimitAmount: limitCents === null ? null : fromCents(limitCents),
    invoiceLimitSource: input.invoiceLimit.source,
    invoiceExpectedAmount: fromCents(invoiceCents),
    complementAmount: fromCents(complementCents),
    complementMethod: input.complementMethod,
    cajuAmount: fromCents(cajuCents),
    requiresComplementMethod: complementCents > 0 && input.complementMethod === "none",
    negativeNet: netCents < 0,
    calcVersion: CONTRACTOR_CALC_VERSION,
  };
}

/**
 * Conciliação PJ: nota recebida + complemento pago devem fechar o líquido devido.
 * A diferença é sempre exposta, nunca ajustada automaticamente no cálculo.
 */
export function reconcileContractorClosing(input: {
  netAmount: number;
  invoiceReceivedAmount: number;
  complementPaidAmount: number;
}): { difference: number; status: ReconciliationStatus } {
  const netCents = toCents(input.netAmount, "Líquido devido");
  const settledCents = toCents(input.invoiceReceivedAmount, "Valor da nota") + toCents(input.complementPaidAmount, "Valor complementar");
  const difference = netCents - settledCents;
  if (settledCents === 0 && netCents !== 0) return { difference: fromCents(difference), status: "pending" };
  return { difference: fromCents(difference), status: difference === 0 ? "reconciled" : "divergent" };
}

/** Compara o valor esperado da nota com o valor efetivamente recebido. */
export function invoiceComparison(expectedAmount: number, receivedAmount: number, hasInvoice: boolean): InvoiceStatus {
  if (expectedAmount <= 0) return "not_required";
  if (!hasInvoice) return "pending";
  return toCents(expectedAmount, "Nota esperada") === toCents(receivedAmount, "Nota recebida") ? "validated" : "divergent";
}

/* -------------------------------------------------------------------------- */
/* Proteção dos dados de pagamento (Pix e conta bancária)                      */
/* -------------------------------------------------------------------------- */

export type PayoutAccount = {
  pixKey?: string;
  bankCode?: string;
  bankBranch?: string;
  bankAccount?: string;
  accountType?: string;
  accountHolder?: string;
  holderTaxId?: string;
};

const payoutFields = ["pixKey", "bankCode", "bankBranch", "bankAccount", "accountType", "accountHolder", "holderTaxId"] as const;

export function sanitizePayoutAccount(value: unknown): PayoutAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const account: PayoutAccount = {};
  for (const field of payoutFields) {
    const text = cleanText(source[field], 140);
    if (text) account[field] = text;
  }
  return account;
}

export type SealedPayout = { encryptedValue: string; initializationVector: string; authTag: string; keyVersion: number };

/** Dados bancários e Pix nunca são gravados em claro: AES-256-GCM com a chave do cofre. */
export function sealPayoutAccount(value: unknown): SealedPayout | null {
  const account = sanitizePayoutAccount(value);
  if (!Object.keys(account).length) return null;
  const { key, version } = currentVaultKey();
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  cipher.setAAD(Buffer.from(`fila-dp:payout:v${version}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(account), "utf8"), cipher.final()]);
  return {
    encryptedValue: encrypted.toString("base64"),
    initializationVector: initializationVector.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: version,
  };
}

export function openPayoutAccount(sealed: SealedPayout): PayoutAccount {
  const key = vaultKeyByVersion(sealed.keyVersion);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.initializationVector, "base64"));
    decipher.setAAD(Buffer.from(`fila-dp:payout:v${sealed.keyVersion}`, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.encryptedValue, "base64")), decipher.final()]).toString("utf8");
    return sanitizePayoutAccount(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "PAYOUT_DECRYPTION_FAILED", "Não foi possível abrir os dados de pagamento protegidos.");
  }
}

/** Remove o material criptográfico antes de qualquer resposta HTTP. */
export function withoutSealedPayout<T extends Record<string, unknown>>(row: T) {
  const safe: Record<string, unknown> = { ...row };
  delete safe.payout_encrypted;
  delete safe.payout_iv;
  delete safe.payout_tag;
  return safe;
}

/** Projeção segura: quem só pode ler vê a existência do dado, não o dado. */
export function payoutSummary(sealed: SealedPayout | null, account: PayoutAccount | null) {
  if (!sealed) return { configured: false, pixHint: "", accountHint: "" };
  if (!account) return { configured: true, pixHint: "", accountHint: "" };
  const tail = (value: string | undefined) => (value ? `••••${value.slice(-4)}` : "");
  return { configured: true, pixHint: tail(account.pixKey), accountHint: tail(account.bankAccount) };
}

/* -------------------------------------------------------------------------- */
/* Validação compartilhada                                                     */
/* -------------------------------------------------------------------------- */

export function requiredReason(value: unknown, code = "REASON_REQUIRED") {
  const reason = cleanText(value, 500);
  if (reason.length < 5) throw ApiError.badRequest("Informe uma justificativa com pelo menos 5 caracteres.", code);
  return reason;
}

export function paymentEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = cleanText(value, 60);
  return allowed.includes(candidate as T) ? candidate as T : fallback;
}

export function requiredPaymentEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const candidate = cleanText(value, 60);
  if (!allowed.includes(candidate as T)) throw ApiError.badRequest(`${field} inválido.`, "INVALID_PAYMENT_ENUM");
  return candidate as T;
}

/**
 * Ciclo de vida do fechamento de psicólogos (§34 da especificação do produto).
 * O caminho de volta existe para correções; concluir e reabrir são controlados
 * por capability própria e sempre exigem justificativa.
 */
export const psychologyTransitions: Record<PsychologyClosingStatus, readonly PsychologyClosingStatus[]> = {
  open: ["review"],
  review: ["approval", "open"],
  approval: ["scheduled", "review"],
  scheduled: ["paid", "approval"],
  paid: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["review"],
};

/** Ciclo de vida do fechamento PJ (§47 da especificação do produto). */
export const contractorTransitions: Record<ContractorClosingStatus, readonly ContractorClosingStatus[]> = {
  open: ["review"],
  review: ["approval", "open"],
  approval: ["approved", "review"],
  approved: ["invoice_pending", "review"],
  invoice_pending: ["ready_to_pay", "approved"],
  ready_to_pay: ["paid", "invoice_pending"],
  paid: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["review"],
};

export function assertTransition<T extends string>(transitions: Record<T, readonly T[]>, from: string, to: T) {
  const allowed = transitions[from as T];
  if (!allowed || !allowed.includes(to)) {
    throw ApiError.badRequest(`Transição de ${from} para ${to} não é permitida.`, "INVALID_PAYMENT_TRANSITION");
  }
  return to;
}

/** Fechamentos concluídos são imutáveis; reabrir exige permissão e justificativa. */
export function assertClosingMutable(status: string, closedStatuses: readonly string[] = ["closed", "paid"]) {
  if (closedStatuses.includes(status)) {
    throw ApiError.badRequest("O fechamento está concluído e não pode ser alterado. Reabra com justificativa.", "PAYMENT_CLOSING_LOCKED");
  }
}
