/**
 * O vocabulário das automações (§27).
 *
 * ## Por que existe um módulo só para isto
 *
 * A lista de gatilhos vivia escrita duas vezes: uma no `select` da tela, outra
 * num `includes` da rota — e a rota, ao encontrar um gatilho que não conhecia,
 * **trocava por `card.created` em silêncio**. Uma regra salva assim aparece na
 * lista com o nome que a pessoa deu e dispara no momento errado, sem erro
 * nenhum em lugar nenhum. É a pior forma de divergir, porque cada lado parece
 * certo sozinho.
 *
 * Aqui a lista é uma só. A tela a percorre para desenhar as opções, a rota a
 * usa para recusar o que não conhece, e um teste cobra que as duas continuem
 * lendo daqui.
 *
 * ## O que o §27 pedia e faltava
 *
 * O motor de regras existia e nenhum evento de **processo** o alcançava: mover
 * etapa mudava a demanda sem que nenhuma regra soubesse. "Etapa Documentação
 * concluída → iniciar Registro" e "processo concluído → registrar evento" são
 * exatamente isso. E das ações, nenhuma avisava ninguém — a automação mexia no
 * quadro em silêncio, e a pessoa descobria depois.
 */

/** Os eventos que uma regra pode escutar. */
export const RULE_TRIGGERS = [
  "card.created",
  "card.moved",
  "assignee.added",
  "checklist.completed",
  "sla.tick",
  "process.step_advanced",
  "process.instance_completed",
] as const;

export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

export const DEFAULT_RULE_TRIGGER: RuleTrigger = "card.created";

/** Como cada gatilho é lido na tela — a mesma frase na lista e na prévia. */
export const RULE_TRIGGER_LABELS: Record<RuleTrigger, string> = {
  "card.created": "uma demanda for criada",
  "card.moved": "uma demanda for movimentada",
  "assignee.added": "um responsável for atribuído",
  "checklist.completed": "todas as etapas forem concluídas",
  "sla.tick": "o SLA for avaliado",
  "process.step_advanced": "uma etapa do processo for concluída",
  "process.instance_completed": "um processo for concluído",
};

export function parseRuleTrigger(raw: unknown): RuleTrigger | null {
  const value = String(raw ?? "").trim();
  return (RULE_TRIGGERS as readonly string[]).includes(value) ? value as RuleTrigger : null;
}

/* -------------------------------------------------------------------------- *
 * Ação
 * -------------------------------------------------------------------------- */

/** As ações que o executor sabe executar — nem uma a mais. */
export const RULE_ACTIONS = ["moveTo", "slaStatus", "labelId", "notify"] as const;
export type RuleActionKind = (typeof RULE_ACTIONS)[number];

export type RuleAction =
  | { moveTo: string }
  | { slaStatus: string }
  | { labelId: string }
  | { notify: string };

const SLA_STATUSES = new Set(["safe", "overdue", "paused", "completed", "recalculate"]);

/** Texto de aviso sem controle nem marcação: ele vai para a caixa de alguém. */
function safeText(value: unknown, limit: number) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

/**
 * A ação, montada campo a campo.
 *
 * Guardar o objeto que chegou seria guardar uma regra que o executor não sabe
 * executar: ela apareceria configurada na tela e nunca faria nada. Devolver
 * `null` faz a rota recusar, que é o que a pessoa precisa ver.
 */
export function parseRuleAction(raw: unknown): RuleAction | null {
  if (!raw || typeof raw !== "object") return null;
  const action = raw as Record<string, unknown>;

  if (typeof action.moveTo === "string" && action.moveTo.trim()) {
    return { moveTo: safeText(action.moveTo, 60) };
  }
  if (typeof action.slaStatus === "string" && SLA_STATUSES.has(action.slaStatus.trim())) {
    return { slaStatus: action.slaStatus.trim() };
  }
  if (typeof action.labelId === "string" && action.labelId.trim()) {
    return { labelId: safeText(action.labelId, 60) };
  }
  if (typeof action.notify === "string" && safeText(action.notify, 160)) {
    return { notify: safeText(action.notify, 160) };
  }
  return null;
}
