import { ApiError } from "./api-errors.ts";
import { cleanText, optionalDate } from "./registrations.ts";
import {
  componentDirectionFor, contractorCreditTypes, contractorDebitTypes, contractorSettlementTarget, toCents,
  type ContractorComponentType, type ContractorSettlementTarget,
} from "./payments.ts";
import {
  assertCompetence, assertContractCoherent,
  type ContractType, type ContractorStatus, type FixedItemDirection, type MovementType,
} from "./contractor-registry.ts";

/**
 * Leitura do que chega do cliente no cadastro de PJ.
 *
 * Fica separado das rotas porque as mesmas regras valem para criar e para
 * editar, e porque um lugar só para validar é o que impede a edição de aceitar
 * o que a criação recusa — uma divergência que só aparece quando alguém corrige
 * um cadastro e o deixa em estado impossível.
 */

const CONTRACT_TYPES: readonly ContractType[] = ["determinado", "indeterminado"];
const CONTRACTOR_STATUSES: readonly ContractorStatus[] = ["active", "suspended", "inactive"];
const COMPONENT_TYPES = [...contractorCreditTypes, ...contractorDebitTypes] as const;
const COMPLEMENT_METHODS = ["none", "caju_saldo_livre", "other_benefit_card", "manual_transfer"] as const;
const MOVEMENT_TYPES: readonly MovementType[] = [
  "base_change", "fixed_item_change", "contract_extension", "contract_value_change",
  "suspension", "reactivation", "termination", "invoice_limit_change", "complement_change", "other",
];

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const raw = cleanText(value, 40);
  if (!allowed.includes(raw as T)) {
    throw ApiError.badRequest(`${field} inválido.`, "INVALID_ENUM");
  }
  return raw as T;
}

/** Dinheiro digitado, em centavos. `null` quando o campo não foi enviado. */
function optionalCents(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const cents = toCents(value, field);
  if (cents < 0) throw ApiError.badRequest(`${field} não pode ser negativo.`, "NEGATIVE_MONEY");
  return cents;
}

export type ContractorInput = {
  legalName: string;
  tradeName: string;
  taxId: string;
  email: string;
  phone: string;
  companyId: string;
  contractReference: string;
  roleTitle: string;
  contractType: ContractType;
  contractStart: string | null;
  contractEnd: string | null;
  contractTotalCents: number | null;
  contractSignedAt: string | null;
  baseAmountCents: number;
  fixedCajuDifferenceCents: number;
  invoiceLimitCents: number | null;
  complementMethod: string;
  paymentDay: number | null;
  status: ContractorStatus;
  notes: string;
};

export function readContractorInput(body: Record<string, unknown>, options: { requireCompany: boolean }): ContractorInput {
  const legalName = cleanText(body.legalName, 180);
  if (!legalName) throw ApiError.badRequest("Informe a razão social do prestador.", "CONTRACTOR_NAME_REQUIRED");

  const companyId = cleanText(body.companyId, 60);
  if (options.requireCompany && !companyId) {
    throw ApiError.badRequest("Informe a empresa contratante.", "CONTRACTOR_COMPANY_REQUIRED");
  }

  // CNPJ ou CPF: o prestador PJ pode ser pessoa jurídica ou autônomo com CPF, e
  // a exportação para o cartão de benefício exige justamente o CPF.
  const taxId = cleanText(body.taxId, 20).replace(/\D/gu, "");
  if (taxId && taxId.length !== 11 && taxId.length !== 14) {
    throw ApiError.badRequest("CNPJ precisa ter 14 dígitos e CPF, 11.", "CONTRACTOR_TAX_ID_INVALID");
  }

  const contractType = pickEnum(body.contractType ?? "indeterminado", CONTRACT_TYPES, "Tipo de contrato");
  const contractStart = optionalDate(body.contractStart);
  const contractEnd = optionalDate(body.contractEnd);
  const contractTotalCents = optionalCents(body.contractTotalAmount, "Valor global do contrato");

  assertContractCoherent({ contractType, contractStart, contractEnd, contractTotalCents });

  const paymentDayRaw = body.paymentDay;
  const paymentDay = paymentDayRaw === null || paymentDayRaw === undefined || paymentDayRaw === ""
    ? null
    : Number(paymentDayRaw);
  if (paymentDay !== null && (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31)) {
    throw ApiError.badRequest("O dia de pagamento precisa estar entre 1 e 31.", "PAYMENT_DAY_INVALID");
  }

  return {
    legalName,
    tradeName: cleanText(body.tradeName, 180),
    taxId,
    email: cleanText(body.email, 180).toLowerCase(),
    phone: cleanText(body.phone, 40),
    companyId,
    contractReference: cleanText(body.contractReference, 120),
    roleTitle: cleanText(body.roleTitle, 120),
    contractType,
    contractStart,
    contractEnd,
    contractTotalCents,
    contractSignedAt: optionalDate(body.contractSignedAt),
    baseAmountCents: optionalCents(body.baseAmount, "Valor fixo mensal") ?? 0,
    fixedCajuDifferenceCents: optionalCents(body.fixedCajuDifference, "Diferença fixa paga no Caju") ?? 0,
    invoiceLimitCents: optionalCents(body.invoiceLimitOverride, "Limite da nota"),
    complementMethod: pickEnum(body.complementMethod ?? "none", COMPLEMENT_METHODS, "Forma de complemento"),
    paymentDay,
    status: pickEnum(body.status ?? "active", CONTRACTOR_STATUSES, "Situação"),
    notes: cleanText(body.notes, 600),
  };
}

export type FixedItemInput = {
  direction: FixedItemDirection;
  componentType: string;
  description: string;
  amountCents: number;
  /** Onde o desconto recorrente é abatido; ver `contractorSettlementTargets`. */
  settlementTarget: ContractorSettlementTarget;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string;
};

export function readFixedItemInput(body: Record<string, unknown>): FixedItemInput {
  const amountCents = optionalCents(body.amount, "Valor") ?? 0;
  if (amountCents <= 0) throw ApiError.badRequest("Informe um valor maior que zero.", "COMPONENT_AMOUNT_REQUIRED");

  // O tipo vem da mesma lista dos componentes da competência, porque é nela que
  // o valor fixo se materializa. Aceitar texto livre aqui deixava o cadastro
  // passar e a apuração quebrar depois, contra a constraint da outra tabela.
  const componentType = pickEnum(body.componentType, COMPONENT_TYPES, "Tipo do valor recorrente");

  const effectiveFrom = assertCompetence(cleanText(body.effectiveFrom, 7), "Competência inicial");
  const effectiveToRaw = cleanText(body.effectiveTo, 7);
  const effectiveTo = effectiveToRaw ? assertCompetence(effectiveToRaw, "Competência final") : null;
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw ApiError.badRequest("A competência final não pode ser anterior à inicial.", "FIXED_ITEM_WINDOW_INVALID");
  }

  // Direção não é escolha independente: ela decorre do tipo.
  const direction = componentDirectionFor(componentType as ContractorComponentType);

  return {
    direction,
    componentType,
    description: cleanText(body.description, 180),
    amountCents,
    // Provento não escolhe incidência; a normalização mora num lugar só.
    settlementTarget: contractorSettlementTarget(body.settlementTarget, direction),
    effectiveFrom,
    effectiveTo,
    note: cleanText(body.note, 300),
  };
}

export type MovementInput = {
  movementType: MovementType;
  effectiveDate: string;
  title: string;
  reason: string;
  effect: {
    baseAmountCents?: number;
    invoiceLimitCents?: number | null;
    complementMethod?: string;
    contractEnd?: string | null;
    contractTotalCents?: number | null;
    status?: ContractorStatus;
  };
};

export function readMovementInput(body: Record<string, unknown>): MovementInput {
  const movementType = pickEnum(body.movementType, MOVEMENT_TYPES, "Tipo de movimentação");
  const effectiveDate = optionalDate(body.effectiveDate, true) as string;
  const title = cleanText(body.title, 180);
  if (!title) throw ApiError.badRequest("Descreva a movimentação em uma linha.", "MOVEMENT_TITLE_REQUIRED");

  const raw = (body.effect ?? {}) as Record<string, unknown>;
  const effect: MovementInput["effect"] = {};
  if (raw.baseAmount !== undefined) effect.baseAmountCents = optionalCents(raw.baseAmount, "Novo valor fixo") ?? 0;
  if (raw.invoiceLimitOverride !== undefined) effect.invoiceLimitCents = optionalCents(raw.invoiceLimitOverride, "Novo limite da nota");
  if (raw.complementMethod !== undefined) effect.complementMethod = pickEnum(raw.complementMethod, COMPLEMENT_METHODS, "Forma de complemento");
  if (raw.contractEnd !== undefined) effect.contractEnd = optionalDate(raw.contractEnd) || null;
  if (raw.contractTotalAmount !== undefined) effect.contractTotalCents = optionalCents(raw.contractTotalAmount, "Novo valor do contrato");
  if (raw.status !== undefined) effect.status = pickEnum(raw.status, CONTRACTOR_STATUSES, "Situação");

  // Tipos que mudam a situação trazem o efeito implícito: pedir que a tela o
  // repita seria só uma chance a mais de divergir do que o nome diz.
  if (movementType === "suspension") effect.status = "suspended";
  if (movementType === "reactivation") effect.status = "active";

  const reason = cleanText(body.reason, 400);
  if (movementType === "termination") {
    effect.status = "inactive";
    // Encerramento e data de término são o mesmo fato de negócio. Gravar só o
    // status impediria distinguir competência histórica de competência futura.
    effect.contractEnd = effectiveDate;
    if (!reason) {
      throw ApiError.badRequest("Informe o motivo do encerramento.", "TERMINATION_REASON_REQUIRED");
    }
  }

  return { movementType, effectiveDate, title, reason, effect };
}

/**
 * Os pares prestador-valor de um lançamento em lote.
 *
 * Devolve `null` quando o corpo não traz lote — é assim que a rota distingue
 * as duas formas de lançar sem precisar de um sinalizador à parte, que um
 * cliente poderia mandar errado.
 *
 * O teto de duzentos não é arbitrário: é mais que o maior grupo em operação e
 * pequeno o bastante para a requisição não estourar o tempo da função. Sem
 * teto, um corpo com dez mil entradas viraria dez mil idas ao banco dentro de
 * uma requisição só.
 */
export function readBatchEntries(value: unknown): Array<{ providerId: string; amount: number }> | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) throw ApiError.badRequest("Informe ao menos um prestador com valor.", "BATCH_EMPTY");
  if (value.length > 200) throw ApiError.badRequest("São no máximo 200 prestadores por lançamento.", "BATCH_TOO_LARGE");

  const entries: Array<{ providerId: string; amount: number }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = (item ?? {}) as Record<string, unknown>;
    const providerId = cleanText(row.providerId ?? row.contractorId, 120);
    if (!providerId) throw ApiError.badRequest("Há uma linha sem prestador.", "BATCH_PROVIDER_REQUIRED");
    /* O mesmo prestador duas vezes no mesmo lote quase sempre é engano de
       preenchimento, e lançar os dois valores em silêncio é o pior desfecho:
       a apuração fecha com um número que ninguém digitou de propósito. */
    if (seen.has(providerId)) throw ApiError.badRequest("O mesmo prestador aparece duas vezes no lançamento.", "BATCH_DUPLICATE");
    seen.add(providerId);
    const amountCents = optionalCents(row.amount, "Valor") ?? 0;
    // Linha em branco é ignorada: quem preenche a lista deixa vazia a de quem
    // não recebe aquela rubrica, e obrigar a apagar seria trabalho sem motivo.
    if (amountCents <= 0) continue;
    entries.push({ providerId, amount: amountCents / 100 });
  }
  if (entries.length === 0) throw ApiError.badRequest("Nenhuma linha tem valor preenchido.", "BATCH_EMPTY");
  return entries;
}
