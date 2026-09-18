/**
 * Adiantamentos e Descontos: validação de entrada e tradução de linha.
 *
 * A aritmética mora em `lib/payroll-ledger.ts` e não conhece banco. Este
 * arquivo é a camada entre o corpo de uma requisição e o que o PostgreSQL
 * aceita — e existe para que as rotas fiquem curtas o bastante para se ler
 * inteiras.
 *
 * As recusas aqui são sempre nomeadas. O banco já barra tudo isto por CHECK e
 * por trigger, mas uma violação de constraint devolvida crua diz
 * `fdp_ledger_entries_modality_shape_check` para um analista de DP — que não
 * tem como saber que isso significa "vale fixo não tem valor total".
 */
import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";
import {
  advanceAmount, competenceSeries, fromCents, isCompetence, ledgerAdvanceModes, ledgerCategories,
  ledgerCategoryFields, ledgerModalities, ledgerSettlementTargets, planInstallments, toCents,
  type LedgerAdvanceMode, type LedgerCategory, type LedgerModality, type LedgerSettlementTarget,
} from "./payroll-ledger.ts";

/** Teto de uma listagem. Acima dele a tela pede um recorte menor. */
export const MAX_LEDGER_RECORDS = 2000;

/**
 * Teto de parcelas de um lançamento.
 *
 * Não é limitação técnica: é a fronteira do que um parcelamento de desconto em
 * folha costuma ser. Um pedido de 500 parcelas quase sempre é um erro de
 * digitação, e aceitar silenciosamente geraria 500 linhas que alguém teria de
 * apagar uma a uma.
 */
export const MAX_INSTALLMENTS = 120;

function enumOr<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const raw = cleanText(value, 60);
  if (!allowed.includes(raw as T)) {
    throw ApiError.badRequest(`Valor inválido para ${field}.`, "INVALID_LEDGER_FIELD");
  }
  return raw as T;
}

/**
 * Texto de um campo que pode chegar como número.
 *
 * `cleanText` devolve "" para qualquer coisa que não seja string, e os campos
 * de dinheiro chegam como número quando a tela usa `<input type="number">`.
 * Sem esta normalização, uma base salarial digitada viraria "ausente" e o
 * adiantamento percentual cairia em pendência com o valor na mão.
 */
function scalarText(value: unknown, max: number): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return cleanText(value, max);
}

function optionalId(value: unknown): string | null {
  const raw = cleanText(value, 120);
  return raw || null;
}

function requiredDate(value: unknown, field: string): string {
  const raw = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw ApiError.badRequest(`Informe ${field} no formato AAAA-MM-DD.`, "INVALID_LEDGER_DATE");
  }
  return raw;
}

function optionalDate(value: unknown, field: string): string | null {
  const raw = cleanText(value, 10);
  if (!raw) return null;
  return requiredDate(raw, field);
}

function requiredCompetence(value: unknown, field: string): string {
  const raw = cleanText(value, 7);
  if (!isCompetence(raw)) {
    throw ApiError.badRequest(`Informe ${field} no formato AAAA-MM.`, "INVALID_LEDGER_COMPETENCE");
  }
  return raw;
}

/**
 * Valor monetário positivo, em centavos.
 *
 * Aceita número e o texto que a tela manda ("1.234,56"), porque o campo é
 * digitado por gente. Recusa zero: um desconto de R$ 0,00 é um lançamento que
 * não desconta nada e que ninguém vai perceber que está errado.
 */
function requiredAmountCents(value: unknown, field: string): number {
  let cents: number;
  try {
    cents = toCents(typeof value === "number" || typeof value === "string" ? value : "");
  } catch {
    throw ApiError.badRequest(`Informe ${field} como um valor em reais.`, "INVALID_LEDGER_AMOUNT");
  }
  if (!Number.isFinite(cents) || cents <= 0) {
    throw ApiError.badRequest(`Informe ${field} maior que zero.`, "INVALID_LEDGER_AMOUNT");
  }
  if (cents > 1_000_000_000) {
    throw ApiError.badRequest(`O valor de ${field} está acima do que o módulo aceita.`, "INVALID_LEDGER_AMOUNT");
  }
  return cents;
}

/**
 * Os campos extras da categoria, filtrados pela própria categoria.
 *
 * Só entra em `details_json` o que a categoria declara em
 * `ledgerCategoryFields`. Sem este filtro, um cliente poderia gravar qualquer
 * chave no JSON — e o que entra em documento financeiro é o que o produto
 * previu, não o que o navegador mandou.
 */
export function parseCategoryDetails(category: LedgerCategory, value: unknown): Record<string, string> {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const details: Record<string, string> = {};
  for (const field of ledgerCategoryFields[category]) {
    const raw = scalarText(source[field.key], field.kind === "text" ? 240 : 40);
    if (!raw) continue;
    if (field.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw ApiError.badRequest(`Informe ${field.label} no formato AAAA-MM-DD.`, "INVALID_LEDGER_DATE");
    }
    if (field.kind === "amount") {
      details[field.key] = String(fromCents(requiredAmountCents(raw, field.label)));
      continue;
    }
    details[field.key] = raw;
  }
  return details;
}

export type LedgerEntryInput = {
  companyId: string;
  employeeId: string | null;
  providerId: string | null;
  departmentId: string | null;
  departmentLabel: string;
  unitLabel: string;
  operationLabel: string;
  requesterAreaId: string | null;
  responsibleAreaId: string | null;
  category: LedgerCategory;
  title: string;
  description: string;
  reason: string;
  occurredOn: string | null;
  requestedOn: string;
  responsibleUserId: string | null;
  /** Nulo no recorrente: não existe total quando não existe prazo. */
  totalAmount: number | null;
  totalCents: number | null;
  /** Só no recorrente: o valor de cada competência, que vira a primeira vigência. */
  recurringCents: number | null;
  modality: LedgerModality;
  installmentCount: number | null;
  firstCompetence: string;
  expectedEndCompetence: string | null;
  recurrenceEndCompetence: string | null;
  settlementTarget: LedgerSettlementTarget;
  details: Record<string, string>;
};

/**
 * O corpo de um lançamento, validado.
 *
 * Três recusas nomeadas concentram o que o formulário erra:
 *
 *  * pessoa **ou** prestador, nunca os dois nem nenhum;
 *  * prestador liquida no pagamento PJ, colaborador liquida na folha;
 *  * recorrente não tem total nem quantidade de parcelas.
 */
export function parseLedgerEntryInput(body: Record<string, unknown>): LedgerEntryInput {
  const companyId = cleanText(body.companyId, 120);
  if (!companyId) throw ApiError.badRequest("Selecione a empresa do lançamento.", "LEDGER_COMPANY_REQUIRED");

  const employeeId = optionalId(body.employeeId);
  const providerId = optionalId(body.providerId);
  if (employeeId && providerId) {
    throw ApiError.badRequest("Um lançamento pertence a um colaborador ou a um prestador, nunca aos dois.", "LEDGER_SUBJECT_AMBIGUOUS");
  }
  if (!employeeId && !providerId) {
    throw ApiError.badRequest("Selecione o colaborador ou o prestador do lançamento.", "LEDGER_SUBJECT_REQUIRED");
  }

  const category = enumOr(body.category, ledgerCategories, "categoria");
  const modality = enumOr(body.modality, ledgerModalities, "modalidade");
  const settlementTarget = enumOr(body.settlementTarget ?? (providerId ? "contractor_payment" : "payroll"), ledgerSettlementTargets, "destino");

  /* A fronteira PJ/CLT. O banco recusa a combinação errada por CHECK; aqui ela
     vira uma frase que diz qual dos dois campos corrigir. */
  if (providerId && settlementTarget !== "contractor_payment") {
    throw ApiError.badRequest("Um lançamento de prestador é liquidado no pagamento PJ.", "LEDGER_TARGET_MISMATCH");
  }
  if (employeeId && settlementTarget === "contractor_payment") {
    throw ApiError.badRequest("Um lançamento de colaborador não é liquidado no pagamento PJ.", "LEDGER_TARGET_MISMATCH");
  }

  const title = cleanText(body.title, 180);
  if (!title) throw ApiError.badRequest("Descreva o lançamento em poucas palavras.", "LEDGER_TITLE_REQUIRED");

  const firstCompetence = requiredCompetence(body.firstCompetence, "a primeira competência");

  let totalCents: number | null = null;
  let installmentCount: number | null = null;
  /** O valor de cada mês do recorrente, que vira a primeira vigência. */
  let recurringCents: number | null = null;
  if (modality === "recurring") {
    /* Recorrente sem prazo não tem saldo devedor total. Recusar aqui evita que
       a pessoa preencha um total que o produto vai ignorar — e que ela depois
       vá cobrar dele. */
    if (body.totalAmount !== undefined && body.totalAmount !== null && body.totalAmount !== "") {
      throw ApiError.badRequest(
        "Desconto recorrente sem prazo não tem valor total: ele tem um valor por competência e uma vigência.",
        "LEDGER_RECURRING_HAS_NO_TOTAL",
      );
    }
    /* Mas ele precisa do valor **do mês**, e é obrigatório: sem ele o
       lançamento nasce sem número nenhum, não entra em conferência e não tem
       como ser descontado. Era o que acontecia antes deste campo existir. */
    recurringCents = requiredAmountCents(body.recurringAmount, "o valor por competência");
  } else {
    totalCents = requiredAmountCents(body.totalAmount, "o valor total");
    installmentCount = modality === "single" ? 1 : Math.trunc(Number(body.installmentCount ?? 0));
    if (!Number.isInteger(installmentCount) || installmentCount < 1) {
      throw ApiError.badRequest("Informe a quantidade de parcelas.", "LEDGER_INSTALLMENTS_REQUIRED");
    }
    if (installmentCount > MAX_INSTALLMENTS) {
      throw ApiError.badRequest(`O módulo aceita até ${MAX_INSTALLMENTS} parcelas por lançamento.`, "LEDGER_INSTALLMENTS_LIMIT");
    }
    if (installmentCount > totalCents) {
      throw ApiError.badRequest("O valor total não se divide na quantidade de parcelas informada.", "LEDGER_INSTALLMENTS_TOO_MANY");
    }
  }

  const recurrenceEndCompetence = cleanText(body.recurrenceEndCompetence, 7)
    ? requiredCompetence(body.recurrenceEndCompetence, "o fim da vigência")
    : null;
  if (recurrenceEndCompetence && recurrenceEndCompetence < firstCompetence) {
    throw ApiError.badRequest("O fim da vigência é anterior à primeira competência.", "LEDGER_RANGE_INVERTED");
  }

  const expectedEndCompetence = installmentCount && installmentCount > 0
    ? competenceSeries(firstCompetence, installmentCount).at(-1) ?? null
    : recurrenceEndCompetence;

  return {
    companyId,
    employeeId,
    providerId,
    departmentId: optionalId(body.departmentId),
    departmentLabel: cleanText(body.departmentLabel, 120),
    unitLabel: cleanText(body.unitLabel, 120),
    operationLabel: cleanText(body.operationLabel, 120),
    requesterAreaId: optionalId(body.requesterAreaId),
    responsibleAreaId: optionalId(body.responsibleAreaId),
    category,
    title,
    description: cleanText(body.description, 1000),
    reason: cleanText(body.reason, 1000),
    occurredOn: optionalDate(body.occurredOn, "a data da ocorrência"),
    requestedOn: cleanText(body.requestedOn, 10)
      ? requiredDate(body.requestedOn, "a data da solicitação")
      : new Date().toISOString().slice(0, 10),
    responsibleUserId: optionalId(body.responsibleUserId),
    totalAmount: totalCents === null ? null : fromCents(totalCents),
    totalCents,
    recurringCents,
    modality,
    installmentCount,
    firstCompetence,
    expectedEndCompetence,
    recurrenceEndCompetence,
    settlementTarget,
    details: parseCategoryDetails(category, body.details),
  };
}

export type PlannedRow = {
  id: string;
  number: number;
  totalCount: number;
  competence: string;
  plannedAmount: number;
};

/**
 * As parcelas que um lançamento gera ao ser aprovado.
 *
 * Recorrente não gera nada aqui: as ocorrências dele nascem competência a
 * competência, na conferência do mês, porque não existe fim para programar.
 */
export function plannedRowsFor(input: Pick<LedgerEntryInput, "modality" | "totalCents" | "installmentCount" | "firstCompetence">): PlannedRow[] {
  if (input.modality === "recurring" || input.totalCents === null || !input.installmentCount) return [];
  return planInstallments({
    totalCents: input.totalCents,
    count: input.installmentCount,
    firstCompetence: input.firstCompetence,
  }).map((part) => ({
    id: crypto.randomUUID(),
    number: part.number,
    totalCount: part.totalCount,
    competence: part.competence,
    plannedAmount: fromCents(part.plannedCents),
  }));
}

export type AdvanceRuleInputParsed = {
  mode: LedgerAdvanceMode;
  fixedAmount: number | null;
  percentage: number | null;
  salaryBaseAmount: number | null;
  salaryBaseSource: "" | "manual" | "hr_metrics";
  effectiveFromCompetence: string;
  endCompetence: string | null;
  note: string;
  /** Vazio quando a regra calcula; preenchido quando falta base salarial. */
  pendingReason: string;
};

/**
 * A regra de um adiantamento.
 *
 * O percentual é aceito **sem** base salarial de propósito: o produto não
 * guarda salário, e recusar a regra obrigaria o DP a inventar um valor fixo
 * para registrar o que na prática é um percentual. O que ele não faz é
 * calcular sobre zero — a competência aparece como pendência nomeada até que
 * alguém informe a base.
 */
export function parseAdvanceRuleInput(body: Record<string, unknown>): AdvanceRuleInputParsed {
  const mode = enumOr(body.mode, ledgerAdvanceModes, "modo do adiantamento");
  const effectiveFromCompetence = requiredCompetence(body.effectiveFromCompetence, "a competência de início da vigência");
  const endCompetence = cleanText(body.endCompetence, 7)
    ? requiredCompetence(body.endCompetence, "a competência de fim da vigência")
    : null;
  if (endCompetence && endCompetence < effectiveFromCompetence) {
    throw ApiError.badRequest("O fim da vigência é anterior ao início.", "LEDGER_RANGE_INVERTED");
  }

  let fixedAmount: number | null = null;
  let percentage: number | null = null;
  let salaryBaseAmount: number | null = null;
  let salaryBaseSource: "" | "manual" | "hr_metrics" = "";

  if (mode === "percentage") {
    const raw = Number(body.percentage);
    if (!Number.isFinite(raw) || raw <= 0 || raw > 100) {
      throw ApiError.badRequest("Informe um percentual entre 0 e 100.", "INVALID_LEDGER_PERCENTAGE");
    }
    percentage = Math.round(raw * 10000) / 10000;
    const base = scalarText(body.salaryBaseAmount, 30);
    if (base) {
      salaryBaseAmount = fromCents(requiredAmountCents(base, "a base salarial"));
      salaryBaseSource = "manual";
    }
  } else {
    fixedAmount = fromCents(requiredAmountCents(body.fixedAmount, "o valor do adiantamento"));
  }

  const resolved = advanceAmount({ mode, fixedAmount, percentage, salaryBaseAmount });
  return {
    mode, fixedAmount, percentage, salaryBaseAmount, salaryBaseSource,
    effectiveFromCompetence, endCompetence,
    note: cleanText(body.note, 500),
    pendingReason: resolved.ok ? "" : resolved.pendingReason,
  };
}

const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** Uma linha de `fdp_ledger_entries` como a tela a lê. */
export function ledgerEntryFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    companyName: String(row.company_name ?? ""),
    employeeId: row.employee_id ? String(row.employee_id) : "",
    employeeName: String(row.employee_name ?? ""),
    providerId: row.provider_id ? String(row.provider_id) : "",
    providerName: String(row.provider_name ?? ""),
    registrationNumber: String(row.registration_number ?? ""),
    employmentType: String(row.employment_type_snapshot ?? ""),
    employmentStatus: String(row.employment_status ?? ""),
    terminationDate: row.termination_date ? String(row.termination_date) : "",
    departmentId: row.department_id ? String(row.department_id) : "",
    departmentLabel: String(row.department_label ?? "") || String(row.department_name ?? ""),
    unitLabel: String(row.unit_label ?? ""),
    operationLabel: String(row.operation_label ?? ""),
    requesterAreaId: row.requester_area_id ? String(row.requester_area_id) : "",
    requesterAreaName: String(row.requester_area_name ?? ""),
    responsibleAreaId: row.responsible_area_id ? String(row.responsible_area_id) : "",
    category: String(row.category),
    title: String(row.title),
    description: String(row.description ?? ""),
    reason: String(row.reason ?? ""),
    occurredOn: row.occurred_on ? String(row.occurred_on) : "",
    requestedOn: String(row.requested_on ?? ""),
    requestedBy: String(row.requested_by ?? ""),
    responsibleUserId: row.responsible_user_id ? String(row.responsible_user_id) : "",
    totalAmount: numberOrNull(row.total_amount),
    modality: String(row.modality),
    installmentCount: numberOrNull(row.installment_count),
    firstCompetence: String(row.first_competence ?? ""),
    expectedEndCompetence: row.expected_end_competence ? String(row.expected_end_competence) : "",
    recurrenceEndCompetence: row.recurrence_end_competence ? String(row.recurrence_end_competence) : "",
    settlementTarget: String(row.settlement_target ?? "payroll"),
    status: String(row.status),
    movementId: row.movement_id ? String(row.movement_id) : "",
    originType: String(row.origin_type ?? "manual"),
    originId: String(row.origin_id ?? ""),
    parentEntryId: row.parent_entry_id ? String(row.parent_entry_id) : "",
    details: (row.details_json ?? {}) as Record<string, unknown>,
    approvalNote: String(row.approval_note ?? ""),
    approvedBy: row.approved_by ? String(row.approved_by) : "",
    approvedAt: row.approved_at ? String(row.approved_at) : "",
    canceledReason: String(row.canceled_reason ?? ""),
    /* Somatórios da própria consulta: pedir o saldo em outra ida ao banco por
       lançamento seria o N+1 que a lista de 2000 linhas não aguenta. */
    plannedAmount: Number(row.planned_total ?? 0),
    discountedAmount: Number(row.discounted_total ?? 0),
    remainingAmount: Math.max(0, Number(row.planned_total ?? 0) - Number(row.discounted_total ?? 0)),
    openInstallments: Number(row.open_installments ?? 0),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    version: Number(row.version ?? 1),
  };
}

/** Uma linha de `fdp_ledger_installments` como a tela a lê. */
export function ledgerInstallmentFromRow(row: Record<string, unknown>) {
  const planned = Number(row.planned_amount ?? 0);
  const discounted = Number(row.discounted_amount ?? 0);
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    entryTitle: String(row.entry_title ?? ""),
    category: String(row.category ?? ""),
    companyId: String(row.company_id),
    companyName: String(row.company_name ?? ""),
    employeeId: row.employee_id ? String(row.employee_id) : "",
    employeeName: String(row.employee_name ?? ""),
    providerName: String(row.provider_name ?? ""),
    departmentLabel: String(row.department_label ?? ""),
    unitLabel: String(row.unit_label ?? ""),
    number: Number(row.number ?? 1),
    totalCount: numberOrNull(row.total_count),
    competence: String(row.competence ?? ""),
    plannedAmount: planned,
    discountedAmount: discounted,
    /* O saldo é derivado, nunca lido de coluna: duas fontes para o mesmo número
       é a garantia de que um dia elas discordam. */
    remainingAmount: Math.max(0, planned - discounted),
    status: String(row.status ?? "scheduled"),
    batchId: row.batch_id ? String(row.batch_id) : "",
    note: String(row.note ?? ""),
    rescheduledToCompetence: row.rescheduled_to_competence ? String(row.rescheduled_to_competence) : "",
    settlementTarget: String(row.settlement_target ?? "payroll"),
    entryStatus: String(row.entry_status ?? ""),
    version: Number(row.version ?? 1),
  };
}
