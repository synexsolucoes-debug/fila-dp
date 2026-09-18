/**
 * Adiantamentos e Descontos: a aritmética do módulo.
 *
 * Este arquivo é puro — não acessa banco, sessão nem rede. Tudo que decide
 * dinheiro e competência mora aqui para poder ser testado sozinho, porque é
 * exatamente onde a planilha errava: "5/10 R$ 200,00" escrito à mão não fecha
 * com R$ 2.000,00 quando o total não divide por dez, e ninguém percebe até o
 * colaborador reclamar do último desconto.
 *
 * ## Dinheiro em centavos inteiros
 *
 * Toda conta acontece em centavos (`number` inteiro). Reais em ponto flutuante
 * perdem a soma: `0.1 + 0.2 !== 0.3`, e com dez parcelas o erro aparece no
 * extrato. O banco guarda `numeric(18,2)`, que é exato; a conversão acontece
 * nas bordas, aqui.
 */

/** Categorias de lançamento. Fechadas por CHECK no banco. */
export const ledgerCategories = [
  "salary_advance",
  "loan",
  "traffic_fine",
  "vehicle_deductible",
  "sesmt_discount",
  "equipment_damage",
  "tool_loss",
  "other",
] as const;
export type LedgerCategory = typeof ledgerCategories[number];

export const ledgerCategoryLabels: Record<LedgerCategory, string> = {
  salary_advance: "Adiantamento salarial",
  loan: "Empréstimo",
  traffic_fine: "Multa de trânsito",
  vehicle_deductible: "Franquia de veículo",
  sesmt_discount: "Desconto do SESMT",
  equipment_damage: "Dano a equipamento",
  tool_loss: "Perda de ferramenta",
  other: "Outro desconto",
};

/**
 * Campos extras que cada categoria pede.
 *
 * A janela não cresce para todo mundo: quem lança um desconto simples vê os
 * campos comuns, e só a multa mostra placa e auto de infração. O conteúdo vai
 * para `details_json`, e esta tabela é a única fonte do que a tela desenha.
 */
export const ledgerCategoryFields: Record<LedgerCategory, readonly { key: string; label: string; kind: "text" | "date" | "amount" }[]> = {
  salary_advance: [
    { key: "paymentReference", label: "Referência do pagamento", kind: "text" },
  ],
  loan: [
    { key: "grantedAmount", label: "Valor concedido", kind: "amount" },
    { key: "grantedOn", label: "Data da concessão", kind: "date" },
    { key: "disbursementConfirmed", label: "Confirmação da disponibilização", kind: "text" },
  ],
  traffic_fine: [
    { key: "vehicle", label: "Veículo", kind: "text" },
    { key: "plate", label: "Placa", kind: "text" },
    { key: "ticketNumber", label: "Auto de infração", kind: "text" },
    { key: "infractionDate", label: "Data da infração", kind: "date" },
  ],
  vehicle_deductible: [
    { key: "vehicle", label: "Veículo", kind: "text" },
    { key: "plate", label: "Placa", kind: "text" },
    { key: "incident", label: "Ocorrência", kind: "text" },
    { key: "incidentDate", label: "Data da ocorrência", kind: "date" },
  ],
  sesmt_discount: [
    { key: "incident", label: "Ocorrência", kind: "text" },
    { key: "item", label: "Item", kind: "text" },
    { key: "movementReference", label: "Movimentação de origem", kind: "text" },
  ],
  equipment_damage: [
    { key: "item", label: "Equipamento", kind: "text" },
    { key: "incident", label: "Ocorrência", kind: "text" },
    { key: "incidentDate", label: "Data da ocorrência", kind: "date" },
  ],
  tool_loss: [
    { key: "item", label: "Ferramenta", kind: "text" },
    { key: "incidentDate", label: "Data da ocorrência", kind: "date" },
  ],
  other: [],
};

export const ledgerModalities = ["single", "installments", "recurring"] as const;
export type LedgerModality = typeof ledgerModalities[number];

export const ledgerEntryStatuses = [
  "draft", "pending_approval", "approved", "rejected", "active",
  "suspended", "settled", "canceled", "renegotiated",
] as const;
export type LedgerEntryStatus = typeof ledgerEntryStatuses[number];

export const ledgerEntryStatusLabels: Record<LedgerEntryStatus, string> = {
  draft: "Rascunho",
  pending_approval: "Aguardando aprovação",
  approved: "Aprovado",
  rejected: "Recusado",
  active: "Em desconto",
  suspended: "Suspenso",
  settled: "Quitado",
  canceled: "Cancelado",
  renegotiated: "Renegociado",
};

export const ledgerInstallmentStatuses = [
  "scheduled", "partially_discounted", "discounted", "skipped", "rescheduled", "canceled",
] as const;
export type LedgerInstallmentStatus = typeof ledgerInstallmentStatuses[number];

export const ledgerInstallmentStatusLabels: Record<LedgerInstallmentStatus, string> = {
  scheduled: "Programada",
  partially_discounted: "Descontada em parte",
  discounted: "Descontada",
  skipped: "Pulada",
  rescheduled: "Reprogramada",
  canceled: "Cancelada",
};

export const ledgerBatchStatuses = [
  "draft", "in_review", "approved", "exported", "sent_to_payroll", "confirmed", "closed", "reopened",
] as const;
export type LedgerBatchStatus = typeof ledgerBatchStatuses[number];

/**
 * Os rótulos separam três coisas que a planilha escrevia igual.
 *
 * "Lançado na Domínio" na planilha significava qualquer uma das três, e por isso
 * não significava nenhuma: ninguém sabia, olhando a célula, se o dinheiro tinha
 * saído do salário da pessoa ou se alguém só havia digitado o desconto em outro
 * sistema.
 */
export const ledgerBatchStatusLabels: Record<LedgerBatchStatus, string> = {
  draft: "Em montagem",
  in_review: "Em conferência",
  approved: "Aprovado",
  exported: "Exportado",
  sent_to_payroll: "Lançado na folha",
  confirmed: "Desconto confirmado",
  closed: "Encerrado",
  reopened: "Reaberto",
};

export const ledgerSettlementTargets = ["payroll", "contractor_payment", "other"] as const;
export type LedgerSettlementTarget = typeof ledgerSettlementTargets[number];

export const ledgerOriginTypes = ["manual", "epi_discount", "demand", "import", "renegotiation"] as const;
export type LedgerOriginType = typeof ledgerOriginTypes[number];

export const ledgerAdvanceModes = ["single_competence", "fixed_monthly", "percentage"] as const;
export type LedgerAdvanceMode = typeof ledgerAdvanceModes[number];

const COMPETENCE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isCompetence(value: unknown): value is string {
  return typeof value === "string" && COMPETENCE_PATTERN.test(value);
}

/**
 * Competência + N meses, com virada de ano correta.
 *
 * A conta é feita em meses absolutos desde o ano zero, não somando ao mês e
 * corrigindo depois. Somar 4 a `2026-11` precisa dar `2027-03`, e a versão
 * ingênua (`mes + n`, depois `if (mes > 12)`) erra quando n passa de 12.
 */
export function addCompetenceMonths(competence: string, months: number): string {
  if (!isCompetence(competence)) throw new Error(`Competência inválida: ${competence}`);
  const [year, month] = competence.split("-").map(Number);
  const absolute = year * 12 + (month - 1) + Math.trunc(months);
  const nextYear = Math.floor(absolute / 12);
  const nextMonth = absolute - nextYear * 12 + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

/** Diferença em meses entre duas competências. Negativa quando `to` é anterior. */
export function competenceDistance(from: string, to: string): number {
  if (!isCompetence(from) || !isCompetence(to)) throw new Error("Competência inválida.");
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  return (toYear * 12 + toMonth) - (fromYear * 12 + fromMonth);
}

/** Sequência de competências a partir de uma primeira. */
export function competenceSeries(first: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("Quantidade de competências inválida.");
  return Array.from({ length: count }, (_, index) => addCompetenceMonths(first, index));
}

/** "2026-09" → "09/2026", que é como o DP fala. */
export function formatCompetence(competence: string): string {
  if (!isCompetence(competence)) return competence;
  const [year, month] = competence.split("-");
  return `${month}/${year}`;
}

/** Reais (número ou string) para centavos inteiros, sem passar por float. */
export function toCents(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Valor monetário inválido.");
    return Math.round(value * 100);
  }
  const normalized = value.trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error("Valor monetário inválido.");
  return Math.round(parsed * 100);
}

/** Centavos inteiros para reais com duas casas — o que o `numeric(18,2)` recebe. */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

export function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

/**
 * Divide um total em N parcelas cujos valores somam exatamente o total.
 *
 * O resto em centavos vai para as **primeiras** parcelas, uma unidade cada.
 * R$ 1.000,00 em 3× dá 333,34 + 333,33 + 333,33 — e não 333,33 três vezes, que
 * perderia um centavo, nem 333,34 três vezes, que cobraria dois a mais.
 *
 * A escolha pelas primeiras (e não pelas últimas) é deliberada: o centavo a
 * mais sai na parcela que a pessoa já esperava pagar, em vez de aparecer como
 * surpresa na última — que é justamente a que costuma ser conferida.
 */
export function splitInstallments(totalCents: number, count: number): number[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error("Total inválido para parcelamento.");
  if (!Number.isInteger(count) || count < 1) throw new Error("Quantidade de parcelas inválida.");
  if (count > totalCents && totalCents > 0) {
    throw new Error("Não é possível dividir o valor em mais parcelas do que centavos.");
  }
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export type PlannedInstallment = {
  number: number;
  totalCount: number;
  competence: string;
  plannedCents: number;
};

/** A programação completa: valores que somam o total, competências em sequência. */
export function planInstallments(input: {
  totalCents: number;
  count: number;
  firstCompetence: string;
}): PlannedInstallment[] {
  const amounts = splitInstallments(input.totalCents, input.count);
  const competences = competenceSeries(input.firstCompetence, input.count);
  return amounts.map((plannedCents, index) => ({
    number: index + 1,
    totalCount: input.count,
    competence: competences[index],
    plannedCents,
  }));
}

export type InstallmentBalanceInput = {
  plannedAmount: number;
  discountedAmount: number;
  status: LedgerInstallmentStatus;
};

export type LedgerBalance = {
  /** Soma prevista das parcelas que continuam valendo. */
  plannedCents: number;
  /** Soma efetivamente confirmada, incluindo estornos. */
  discountedCents: number;
  /** O que falta descontar. Nunca negativo. */
  remainingCents: number;
  /** Parcelas que ainda não foram integralmente confirmadas. */
  openInstallments: number;
};

/**
 * O saldo de um lançamento.
 *
 * Parcelas canceladas e reprogramadas saem da conta do previsto: elas não são
 * mais cobrança deste lançamento. Parcelas puladas também — pular é a decisão
 * humana de não descontar naquele mês, e o que sobrou continua visível no
 * saldo pelas parcelas que restam, não recobrado sozinho.
 */
export function ledgerBalance(installments: readonly InstallmentBalanceInput[]): LedgerBalance {
  let plannedCents = 0;
  let discountedCents = 0;
  let openInstallments = 0;
  for (const installment of installments) {
    const planned = toCents(installment.plannedAmount);
    const discounted = toCents(installment.discountedAmount);
    discountedCents += discounted;
    if (installment.status === "canceled" || installment.status === "rescheduled" || installment.status === "skipped") {
      // O que já foi descontado nela continua contando; o previsto, não.
      plannedCents += discounted;
      continue;
    }
    plannedCents += planned;
    if (discounted < planned) openInstallments += 1;
  }
  return {
    plannedCents,
    discountedCents,
    remainingCents: Math.max(0, plannedCents - discountedCents),
    openInstallments,
  };
}

/**
 * Quanto ainda cabe confirmar numa parcela.
 *
 * O banco recusa o excedente por trigger; isto é o mesmo limite calculado antes
 * de tentar, para que a tela diga o número em vez de devolver erro de banco.
 */
export function confirmableCents(installment: InstallmentBalanceInput): number {
  return Math.max(0, toCents(installment.plannedAmount) - toCents(installment.discountedAmount));
}

export type AdvanceRuleInput = {
  mode: LedgerAdvanceMode;
  fixedAmount?: number | null;
  percentage?: number | null;
  salaryBaseAmount?: number | null;
};

export type AdvanceAmount =
  | { ok: true; cents: number }
  | { ok: false; pendingReason: string };

/**
 * O valor do adiantamento de uma competência.
 *
 * Percentual sem base salarial **não** vira zero: vira pendência nomeada. O
 * produto não guarda salário (ver `fdp_employees`), então a base é informada no
 * lançamento — e enquanto não for, a competência aparece na conferência como
 * pendência, não como um pagamento de R$ 0,00 que ninguém notaria.
 */
export function advanceAmount(rule: AdvanceRuleInput): AdvanceAmount {
  if (rule.mode === "percentage") {
    const base = rule.salaryBaseAmount;
    if (base === null || base === undefined || !(base > 0)) {
      return { ok: false, pendingReason: "Informe a base salarial para calcular o adiantamento percentual." };
    }
    const percentage = rule.percentage;
    if (percentage === null || percentage === undefined || !(percentage > 0)) {
      return { ok: false, pendingReason: "Informe o percentual do adiantamento." };
    }
    return { ok: true, cents: Math.round(toCents(base) * percentage / 100) };
  }
  const fixed = rule.fixedAmount;
  if (fixed === null || fixed === undefined || !(fixed > 0)) {
    return { ok: false, pendingReason: "Informe o valor do adiantamento." };
  }
  return { ok: true, cents: toCents(fixed) };
}

/**
 * A regra vigente numa competência.
 *
 * As regras são versionadas por `effective_from_competence` e a vigente é a
 * mais recente que já começou. Alterar o valor com vigência futura não muda o
 * que as competências anteriores já usaram — que é a diferença entre corrigir
 * um valor e reescrever o histórico.
 */
export function ruleInEffect<T extends { effectiveFromCompetence: string; endCompetence?: string | null; status: string }>(
  rules: readonly T[],
  competence: string,
): T | null {
  const eligible = rules
    .filter((rule) => rule.status !== "canceled")
    .filter((rule) => competenceDistance(rule.effectiveFromCompetence, competence) >= 0)
    .filter((rule) => !rule.endCompetence || competenceDistance(competence, rule.endCompetence) >= 0)
    /* `YYYY-MM` ordena como texto porque o mês tem zero à esquerda; comparar
       pela distância entre as duas vigências inverteria a ordem, e a regra
       "vigente" passaria a ser a mais antiga. */
    .sort((left, right) => left.effectiveFromCompetence.localeCompare(right.effectiveFromCompetence));
  return eligible.at(-1) ?? null;
}

/**
 * A chave que impede a baixa dupla.
 *
 * Determinística de propósito: o mesmo usuário confirmando a mesma parcela na
 * mesma competência pelo mesmo valor produz a mesma chave, e o índice único do
 * banco deixa passar a primeira. É o que sobrevive a um duplo clique e a dois
 * analistas conferindo o mesmo lote ao mesmo tempo.
 */
export function confirmationKey(input: {
  installmentId: string;
  competence: string;
  amountCents: number;
  kind: string;
  batchId?: string | null;
}): string {
  return [
    "ledger-confirm",
    input.installmentId,
    input.competence,
    String(input.amountCents),
    input.kind,
    input.batchId ?? "",
  ].join(":");
}

/**
 * O número da ocorrência mensal de um lançamento recorrente.
 *
 * Um recorrente não tem "parcela 3 de 10" — não há total. Mas cada mês precisa
 * de um número estável, porque é `(workspace, lançamento, número)` que impede a
 * mesma competência de virar duas parcelas quando alguém abre a conferência
 * duas vezes. A distância desde a primeira competência dá exatamente isso: ela
 * não depende de quantas vezes a geração rodou, nem da ordem em que os meses
 * foram abertos. Setembro é sempre a mesma ocorrência, aberto hoje ou em março.
 */
export function recurringOccurrenceNumber(firstCompetence: string, competence: string): number {
  const distance = competenceDistance(firstCompetence, competence);
  if (distance < 0) {
    throw new Error("A competência é anterior ao início da recorrência.");
  }
  return distance + 1;
}

/** Chave da ocorrência mensal do adiantamento: gerar a programação duas vezes não paga duas. */
export function advancePaymentKey(entryId: string, competence: string): string {
  return `ledger-advance:${entryId}:${competence}`;
}

/**
 * O identificador que o desconto PJ leva para `fdp_contractor_components`.
 *
 * O índice único `fdp_contractor_components_workspace_external_uq` já existia; é
 * ele que impede o recálculo do fechamento PJ de lançar o mesmo desconto duas
 * vezes. A garantia está no banco, não na ordem em que o serviço roda.
 */
export function contractorProjectionKey(installmentId: string): string {
  return `ledger:${installmentId}`;
}

/** Tipo de componente PJ correspondente à categoria do lançamento. */
export function contractorComponentType(category: LedgerCategory): string {
  switch (category) {
    case "salary_advance": return "advance";
    case "loan": return "loan";
    case "equipment_damage":
    case "tool_loss": return "equipment";
    default: return "other_debit";
  }
}

/** Chave da pendência de desligamento com saldo em aberto. */
export function terminationPendingKey(entryId: string): string {
  return `ledger:${entryId}:termination`;
}

export type TerminationSignal = {
  entryId: string;
  title: string;
  remainingCents: number;
};

/**
 * O que o desligamento produz: sinalização, nunca desconto.
 *
 * Descontar todo o saldo na rescisão não é automático e nem sempre é permitido
 * — depende da verba, do motivo e do que foi acordado por escrito. O produto
 * aponta o saldo para análise humana e para por aí.
 */
export function terminationSignals(
  entries: readonly { id: string; title: string; balance: LedgerBalance }[],
): TerminationSignal[] {
  return entries
    .filter((entry) => entry.balance.remainingCents > 0)
    .map((entry) => ({ entryId: entry.id, title: entry.title, remainingCents: entry.balance.remainingCents }));
}
