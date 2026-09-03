import { ApiError } from "./api-errors.ts";

/**
 * Regras do cadastro de prestador PJ: contrato, saldo, valores fixos e
 * movimentação.
 *
 * O cálculo do pagamento não mora aqui — `calculateContractorClosing`
 * (lib/payments.ts) continua sendo o único lugar que resolve líquido → nota →
 * complemento → Caju. Este módulo decide **o que entra na competência** e **o
 * que o contrato ainda comporta**.
 *
 * Tudo em centavos inteiros. Saldo de contrato calculado em reais com ponto
 * flutuante erraria centavos ao longo de doze competências, e o erro só
 * apareceria na última.
 */

export type ContractType = "determinado" | "indeterminado";
export type ContractorStatus = "active" | "suspended" | "inactive";
export type FixedItemDirection = "credit" | "debit";

/** Competência no formato AAAA-MM — a unidade de vigência do PJ é o mês. */
const COMPETENCE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;

export function isCompetence(value: string) {
  return COMPETENCE_PATTERN.test(value);
}

export function assertCompetence(value: string, field = "Competência") {
  if (!isCompetence(value)) {
    throw ApiError.badRequest(`${field} precisa estar no formato AAAA-MM.`, "INVALID_COMPETENCE");
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Contrato                                                                    */
/* -------------------------------------------------------------------------- */

export type ContractInput = {
  contractType: ContractType;
  contractStart: string | null;
  contractEnd: string | null;
  /** Valor global do contrato em centavos. Só existe no prazo determinado. */
  contractTotalCents: number | null;
};

/**
 * Recusa contrato incoerente antes de gravar.
 *
 * A mesma regra está no banco como CHECK. A duplicação é deliberada: o banco
 * impede o dado inconsistente de existir, e aqui a pessoa recebe a explicação
 * do que faltou em vez de um erro de constraint.
 */
export function assertContractCoherent(input: ContractInput) {
  if (input.contractType === "determinado") {
    if (!input.contractEnd) {
      throw ApiError.badRequest(
        "Contrato por prazo determinado precisa de data de término.",
        "CONTRACT_END_REQUIRED",
      );
    }
    if (input.contractTotalCents === null || input.contractTotalCents <= 0) {
      throw ApiError.badRequest(
        "Contrato por prazo determinado precisa do valor global — é ele que dá o saldo a acompanhar.",
        "CONTRACT_TOTAL_REQUIRED",
      );
    }
  } else if (input.contractTotalCents !== null) {
    throw ApiError.badRequest(
      "Contrato por prazo indeterminado não tem valor global. Use o valor fixo mensal.",
      "CONTRACT_TOTAL_NOT_APPLICABLE",
    );
  }
  if (input.contractStart && input.contractEnd && input.contractEnd < input.contractStart) {
    throw ApiError.badRequest("A data de término não pode ser anterior ao início.", "CONTRACT_WINDOW_INVALID");
  }
}

export type ContractBalance = {
  type: ContractType;
  /** `null` no indeterminado: não existe teto para consumir. */
  totalCents: number | null;
  consumedCents: number;
  remainingCents: number | null;
  /** 0–100, arredondado. `null` quando não há total. */
  usagePercent: number | null;
  exhausted: boolean;
};

/**
 * Saldo do contrato.
 *
 * Consumido é a soma do líquido apurado nas competências já comprometidas —
 * não o previsto. Contrato indeterminado devolve saldo aberto em vez de zero:
 * mostrar "R$ 0,00 restantes" para quem não tem teto seria mentira com cara de
 * número.
 */
export function contractBalance(input: {
  contractType: ContractType;
  contractTotalCents: number | null;
  consumedCents: number;
}): ContractBalance {
  if (input.contractType === "indeterminado" || input.contractTotalCents === null) {
    return {
      type: input.contractType,
      totalCents: null,
      consumedCents: input.consumedCents,
      remainingCents: null,
      usagePercent: null,
      exhausted: false,
    };
  }
  const remainingCents = input.contractTotalCents - input.consumedCents;
  return {
    type: input.contractType,
    totalCents: input.contractTotalCents,
    consumedCents: input.consumedCents,
    remainingCents,
    usagePercent: input.contractTotalCents === 0
      ? null
      : Math.round((input.consumedCents / input.contractTotalCents) * 100),
    exhausted: remainingCents <= 0,
  };
}

/**
 * Recusa a apuração que estouraria o contrato.
 *
 * O bloqueio é do valor, não da data: um contrato pode acabar antes do prazo
 * porque o valor global foi consumido. Passar disso sem avisar cria obrigação
 * de pagamento que o contrato não cobre.
 */
export function assertWithinContract(balance: ContractBalance, closingCents: number, contractorName: string) {
  if (balance.totalCents === null) return;
  const afterCents = balance.consumedCents + closingCents;
  if (afterCents > balance.totalCents) {
    const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    throw new ApiError(409, "CONTRACT_BALANCE_EXCEEDED",
      `A apuração de ${contractorName} passa do valor do contrato. `
      + `Contratado ${money(balance.totalCents)}, já consumido ${money(balance.consumedCents)}, `
      + `esta competência ${money(closingCents)}. Prorrogue o contrato ou ajuste a competência antes de apurar.`,
      {
        totalCents: balance.totalCents,
        consumedCents: balance.consumedCents,
        closingCents,
        overflowCents: afterCents - balance.totalCents,
      });
  }
}

/**
 * Data de contrato que chega do banco, normalizada para `AAAA-MM`.
 *
 * A coluna é `date`, mas o que chega depende do driver: o caminho HTTP do Neon
 * devolve texto e o driver PostgreSQL direto devolve `Date`. Assumir string
 * quebrou a apuração com "date.slice is not a function" — anotação de tipo não
 * é garantia sobre o que vem de fora.
 */
export function competenceOf(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 7);
  const text = String(value);
  return text.length >= 7 ? text.slice(0, 7) : null;
}

/**
 * Contrato vigente na competência.
 *
 * Compara mês com mês: um contrato que termina em 15/03 ainda gera a
 * competência 2026-03, porque a competência é fechada pelo mês inteiro.
 */
export function contractCoversCompetence(
  competence: string,
  contractStart: string | Date | null,
  contractEnd: string | Date | null,
) {
  const start = competenceOf(contractStart);
  const end = competenceOf(contractEnd);
  if (start && start > competence) return false;
  if (end && end < competence) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Valores fixos                                                               */
/* -------------------------------------------------------------------------- */

export type FixedItem = {
  id: string;
  direction: FixedItemDirection;
  componentType: string;
  description: string;
  amountCents: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "active" | "ended";
  /** Onde o desconto recorrente é abatido; ver `contractorSettlementTargets`. */
  settlementTarget?: "auto" | "invoice" | "complement";
};

/**
 * Quais valores fixos valem em uma competência.
 *
 * Item encerrado sai sozinho quando a vigência passa — é justamente para isso
 * que ele existe. Relançar todo mês na mão erra por esquecimento, e o
 * esquecimento só aparece quando o prestador reclama.
 */
export function fixedItemsForCompetence(items: readonly FixedItem[], competence: string) {
  assertCompetence(competence);
  return items.filter((item) => {
    if (item.status !== "active") return false;
    if (item.effectiveFrom > competence) return false;
    if (item.effectiveTo && item.effectiveTo < competence) return false;
    return true;
  });
}

/** Soma dos fixos da competência, separada por direção, em centavos. */
export function fixedItemsTotals(items: readonly FixedItem[]) {
  let creditCents = 0;
  let debitCents = 0;
  for (const item of items) {
    if (item.direction === "credit") creditCents += item.amountCents;
    else debitCents += item.amountCents;
  }
  return { creditCents, debitCents, netCents: creditCents - debitCents };
}

/* -------------------------------------------------------------------------- */
/* Movimentação                                                                */
/* -------------------------------------------------------------------------- */

export type MovementType =
  | "base_change" | "fixed_item_change" | "contract_extension" | "contract_value_change"
  | "suspension" | "reactivation" | "termination" | "invoice_limit_change"
  | "complement_change" | "other";

export type MovementStatus = "draft" | "pending_approval" | "approved" | "rejected" | "applied" | "canceled";

export const movementLabels: Record<MovementType, string> = {
  base_change: "Reajuste do valor fixo",
  fixed_item_change: "Mudança em valor recorrente",
  contract_extension: "Prorrogação de contrato",
  contract_value_change: "Mudança no valor do contrato",
  suspension: "Suspensão",
  reactivation: "Reativação",
  termination: "Encerramento",
  invoice_limit_change: "Mudança no limite da nota",
  complement_change: "Mudança na forma de complemento",
  other: "Outra movimentação",
};

/**
 * Transições possíveis de uma movimentação.
 *
 * `applied` é terminal: movimentação aplicada é histórico e se corrige lançando
 * outra, não reescrevendo a anterior. O banco também impede, por gatilho.
 */
const MOVEMENT_TRANSITIONS: Record<MovementStatus, readonly MovementStatus[]> = {
  draft: ["pending_approval", "canceled"],
  pending_approval: ["approved", "rejected", "canceled"],
  approved: ["applied", "canceled"],
  rejected: ["draft", "canceled"],
  applied: [],
  canceled: [],
};

export function canTransitionMovement(from: MovementStatus, to: MovementStatus) {
  return MOVEMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertMovementTransition(from: MovementStatus, to: MovementStatus) {
  if (canTransitionMovement(from, to)) return;
  if (from === "applied") {
    throw new ApiError(409, "MOVEMENT_APPLIED_LOCKED",
      "Esta movimentação já foi aplicada e virou histórico. Lance uma nova movimentação para corrigir.");
  }
  throw new ApiError(409, "MOVEMENT_TRANSITION_INVALID",
    `Não é possível mudar a movimentação de "${from}" para "${to}".`);
}

/** Alteração que a movimentação faz no contrato quando aplicada. */
export type MovementEffect = {
  baseAmountCents?: number;
  invoiceLimitCents?: number | null;
  complementMethod?: string;
  contractEnd?: string | null;
  contractTotalCents?: number | null;
  status?: ContractorStatus;
};

/**
 * O que cada tipo de movimentação precisa trazer para poder ser aplicada.
 *
 * Uma movimentação sem efeito é registro decorativo: ela apareceria no
 * histórico dando a entender que algo mudou, sem nada ter mudado.
 */
export function assertMovementEffect(type: MovementType, effect: MovementEffect) {
  const required: Partial<Record<MovementType, keyof MovementEffect>> = {
    base_change: "baseAmountCents",
    contract_extension: "contractEnd",
    contract_value_change: "contractTotalCents",
    invoice_limit_change: "invoiceLimitCents",
    complement_change: "complementMethod",
  };
  const field = required[type];
  if (field && effect[field] === undefined) {
    throw ApiError.badRequest(
      `A movimentação "${movementLabels[type]}" precisa informar o novo valor.`,
      "MOVEMENT_EFFECT_REQUIRED",
    );
  }
  if (type === "suspension" && effect.status !== "suspended") {
    throw ApiError.badRequest("A suspensão precisa deixar o prestador suspenso.", "MOVEMENT_EFFECT_INVALID");
  }
  if (type === "reactivation" && effect.status !== "active") {
    throw ApiError.badRequest("A reativação precisa deixar o prestador ativo.", "MOVEMENT_EFFECT_INVALID");
  }
  if (type === "termination" && effect.status !== "inactive") {
    throw ApiError.badRequest("O encerramento precisa inativar o prestador.", "MOVEMENT_EFFECT_INVALID");
  }
  if (type === "termination" && effect.contractEnd === undefined) {
    throw ApiError.badRequest("O encerramento precisa informar a data de término do contrato.", "MOVEMENT_EFFECT_REQUIRED");
  }
  if (effect.baseAmountCents !== undefined && effect.baseAmountCents < 0) {
    throw ApiError.badRequest("Valor fixo não pode ser negativo.", "NEGATIVE_MONEY");
  }
  if (effect.contractTotalCents !== undefined && effect.contractTotalCents !== null && effect.contractTotalCents <= 0) {
    throw ApiError.badRequest("O valor do contrato precisa ser maior que zero.", "CONTRACT_TOTAL_REQUIRED");
  }
}

/**
 * Prorrogação que encurta o contrato abaixo do já consumido seria retroativa
 * sobre competência fechada — o valor já foi apurado e, em muitos casos, pago.
 */
export function assertContractValueNotBelowConsumed(newTotalCents: number | null, consumedCents: number) {
  if (newTotalCents === null) return;
  if (newTotalCents < consumedCents) {
    const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    throw new ApiError(409, "CONTRACT_TOTAL_BELOW_CONSUMED",
      `O contrato já consumiu ${money(consumedCents)}. Não dá para reduzir o valor global para ${money(newTotalCents)} `
      + "sem desfazer competências já apuradas.");
  }
}

/** Prestador que não entra em apuração, e o motivo em linguagem de quem opera. */
export function apurationBlock(status: ContractorStatus, competence: string,
  contractStart: string | Date | null, contractEnd: string | Date | null): string | null {
  if (status === "inactive") {
    const endCompetence = competenceOf(contractEnd);
    // Encerrado com data ainda pode ser reapurado historicamente até o mês do
    // término. Sem data, não há fronteira segura e o bloqueio continua total.
    if (!endCompetence || competence > endCompetence) return "contrato encerrado";
  }
  if (status === "suspended") return "contrato suspenso";
  if (!contractCoversCompetence(competence, contractStart, contractEnd)) {
    return "competência fora da vigência do contrato";
  }
  return null;
}
