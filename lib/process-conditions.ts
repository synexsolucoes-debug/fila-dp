/**
 * Condição de transição entre etapas (§25: "validar condição antes da etapa").
 *
 * O motor já sabia **para onde** a demanda pode ir — o desenho responde isso —
 * mas não sob que critério. Uma admissão de CLT e uma de estagiário saíam da
 * mesma etapa pelas mesmas setas, e cabia à pessoa lembrar qual seguir. Quando
 * o processo tem um "se", deixá-lo fora do sistema é deixá-lo na cabeça de
 * quem executa.
 *
 * Três decisões que valem explicação:
 *
 * 1. **Sem expressão, sem `eval`.** BPMN carrega condição como código
 *    (`${valor > 1000}`), e interpretá-lo significaria executar texto escrito
 *    por quem desenha o processo, no servidor. Aqui a condição é declarativa —
 *    campo, operador, valor — com um conjunto fechado de operadores. O que não
 *    se pode escrever também não se pode explorar.
 *
 * 2. **Fora do XML.** A condição mora no `settings_json` da configuração do
 *    passo de origem, onde o modelador já grava o resto. O diagrama continua
 *    sendo desenho; a regra continua sendo dado consultável — e ninguém precisa
 *    reprocessar XML para saber por que uma demanda parou.
 *
 * 3. **Fato ausente não satisfaz.** Um campo que a demanda não tem faz a
 *    condição falhar, não passar. O contrário deixaria a regra silenciosamente
 *    inerte quando alguém renomeasse um campo — o pior modo de falhar, porque
 *    parece que funciona.
 *
 * O que este módulo **não** faz: decidir se a transição acontece. Ele responde
 * "esta condição bate com estes fatos"; quem decide é
 * `lib/process-instances.ts`, que soma isto a permissão, evidência e aprovação.
 */

/** Operadores aceitos. Fechado de propósito: cada um é um caso testado. */
export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export type TransitionCondition = {
  /** Nome do fato: `priority`, `companyId`, `custom:contrato`… */
  field: string;
  operator: ConditionOperator;
  /** Ignorado por `is_empty` / `is_not_empty`. Em `in`/`not_in`, separado por vírgula. */
  value: string;
};

/** Os fatos da demanda contra os quais a condição é medida. */
export type ConditionFacts = Record<string, string | number | null | undefined>;

/** Condições por seta que sai da etapa. Todas precisam bater (E, não OU). */
export type TransitionConditionMap = Record<string, TransitionCondition[]>;

const OPERATORS = new Set<string>(CONDITION_OPERATORS);

function text(value: unknown, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** `1.234,56` e `1234.56` são o mesmo número para quem digita em português. */
function asNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value, 40);
  if (!raw) return null;
  const normalized = raw.includes(",") ? raw.replace(/\./gu, "").replace(",", ".") : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function list(value: string): string[] {
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/**
 * Lê o mapa de condições gravado pelo modelador, descartando o que não entende.
 *
 * Descartar em vez de recusar é deliberado: uma condição corrompida não pode
 * derrubar o processo inteiro. Mas ela também não vira "sempre verdadeira" —
 * ela simplesmente deixa de existir, e a seta volta a ser incondicional, que é
 * o comportamento que o produto tinha antes desta funcionalidade.
 */
export function parseTransitionConditions(raw: unknown): TransitionConditionMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const map: TransitionConditionMap = {};
  for (const [flowId, entries] of Object.entries(raw as Record<string, unknown>)) {
    const key = text(flowId, 160);
    if (!key || !Array.isArray(entries)) continue;
    const conditions = entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const item = entry as Record<string, unknown>;
        const field = text(item.field, 80);
        const operator = text(item.operator, 20);
        if (!field || !OPERATORS.has(operator)) return null;
        return { field, operator: operator as ConditionOperator, value: text(item.value, 200) };
      })
      .filter((item): item is TransitionCondition => item !== null)
      .slice(0, 12);
    if (conditions.length) map[key] = conditions;
  }
  return map;
}

/** Esta condição bate com estes fatos? */
export function evaluateCondition(condition: TransitionCondition, facts: ConditionFacts): boolean {
  const fact = facts[condition.field];
  const factText = fact == null ? "" : String(fact).trim();
  const lower = factText.toLowerCase();

  switch (condition.operator) {
    case "is_empty": return factText === "";
    case "is_not_empty": return factText !== "";
    case "equals": return lower === condition.value.trim().toLowerCase();
    case "not_equals": return lower !== condition.value.trim().toLowerCase();
    case "in": return list(condition.value).includes(lower);
    case "not_in": return !list(condition.value).includes(lower);
    case "greater_than":
    case "less_than": {
      const left = asNumber(fact);
      const right = asNumber(condition.value);
      // Comparar número com o que não é número não é falso, é sem sentido —
      // e sem sentido não pode liberar passagem.
      if (left === null || right === null) return false;
      return condition.operator === "greater_than" ? left > right : left < right;
    }
    default: return false;
  }
}

/**
 * Lê uma lista solta de condições (regra de entrada ou de saída de etapa, §23).
 *
 * Mesma tolerância do mapa por seta: o que não se entende é descartado, e a
 * regra some em vez de virar "sempre verdadeira". Uma regra corrompida que
 * liberasse a passagem seria pior que regra nenhuma.
 */
export function parseConditionList(raw: unknown): TransitionCondition[] {
  return parseTransitionConditions({ list: raw }).list ?? [];
}

/** As condições que **não** bateram — é o que a tela precisa para dizer o porquê. */
export function unmetConditions(
  conditions: readonly TransitionCondition[] | undefined,
  facts: ConditionFacts,
): TransitionCondition[] {
  if (!conditions?.length) return [];
  return conditions.filter((condition) => !evaluateCondition(condition, facts));
}

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "é",
  not_equals: "não é",
  in: "está entre",
  not_in: "não está entre",
  is_empty: "está vazio",
  is_not_empty: "está preenchido",
  greater_than: "é maior que",
  less_than: "é menor que",
};

/**
 * A condição em português, para o bloqueio dizer o que falta.
 *
 * "PROCESS_TRANSITION_CONDITION_UNMET" não ajuda ninguém a destravar a demanda;
 * "Prioridade é urgente" ajuda.
 */
export function describeCondition(condition: TransitionCondition): string {
  const label = OPERATOR_LABELS[condition.operator];
  const field = condition.field.startsWith("custom:")
    ? condition.field.slice("custom:".length)
    : FACT_LABELS[condition.field] ?? condition.field;
  if (condition.operator === "is_empty" || condition.operator === "is_not_empty") {
    return `${field} ${label}`;
  }
  return `${field} ${label} ${condition.value}`;
}

/** Nomes dos fatos como quem configura o processo os reconhece. */
export const FACT_LABELS: Record<string, string> = {
  priority: "Prioridade",
  company: "Empresa",
  companyId: "Empresa",
  competence: "Competência",
  processType: "Tipo de processo",
  requesterAreaId: "Área solicitante",
  responsibleAreaId: "Área responsável",
  slaStatus: "Situação do prazo",
  pendingChecklist: "Itens de checklist em aberto",
  attachmentCount: "Anexos",
};
