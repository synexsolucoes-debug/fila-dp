/**
 * Execução das automações declaradas na etapa (§27).
 *
 * A auditoria encontrou a aba **Automações** funcionando como resumo
 * somente-leitura de uma única regra — "ao chegar nesta etapa, abrir demanda" —
 * enquanto o briefing pede seis comportamentos. Os outros cinco não existiam em
 * lugar nenhum: as regras de quadro (`fdp_automation_rules`) são do workspace e
 * reagem a evento de cartão, não a etapa de processo, e por desenho não podem
 * saber que "Documentação" da Admissão v3 acabou.
 *
 * Este módulo é a metade que faltava. Ele devolve **statements**, e não
 * resultados, pelo mesmo motivo que `prepareProcessInstance`: quem chama põe
 * tudo no mesmo `batch` da transição, e a automação entra na transação do fato
 * que a disparou. Automação gravada sobre uma transição que não pegou é pior
 * que automação nenhuma — ela afirma um efeito de uma causa que não aconteceu.
 *
 * O que **não** está aqui, de propósito:
 *
 * - `create_demand` continua onde estava, em `createDemand` da configuração da
 *   etapa. Ela já funcionava e já é lida pela ficha; duplicá-la como automação
 *   criaria dois lugares para desligar a mesma coisa.
 * - Nada aqui move etapa. Automação que avança processo sozinha tira do
 *   histórico o ator humano que §16 exige — quem propõe passa pelo motor, e o
 *   motor exige ator identificado.
 */
import type { getD1 } from "../db";

import type { DomainEventName } from "./domain-events.ts";
import { cleanText } from "./registrations.ts";
import {
  automationsFor, parseStepAutomations,
  type AutomationTrigger, type StepAutomationRule,
} from "./process-tasks.ts";

type Database = ReturnType<typeof getD1>;

export type AutomationContext = {
  workspaceId: string;
  cardId: string;
  stepId: string;
  stepLabel: string;
  /** Área responsável da etapa, para a automação que não nomeia a sua. */
  fallbackAreaId?: string | null;
  processDefinitionId?: string;
  processVersionId?: string;
};

/**
 * Chave de idempotência do aviso.
 *
 * O índice único `(user_id, event_key)` de `fdp_notifications` é o que impede a
 * mesma automação de encher a caixa de avisos quando a varredura roda de novo
 * (§82). A chave carrega gatilho, etapa e cartão porque é essa a granularidade
 * do fato: o mesmo cartão pode vencer uma tarefa em duas etapas diferentes, e
 * os dois avisos são legítimos.
 */
export function automationEventKey(
  trigger: AutomationTrigger, context: Pick<AutomationContext, "cardId" | "stepId">, suffix = "",
) {
  return `process-automation:${trigger}:${context.stepId}:${context.cardId}${suffix ? `:${suffix}` : ""}`.slice(0, 200);
}

/**
 * Statements das automações de um gatilho.
 *
 * `record_event` sai por fora, na lista `events`: o envelope do evento de
 * domínio é montado por `lib/outbox.ts`, que precisa do ator e do id da
 * requisição — dados que este módulo não tem e não deveria inventar.
 */
export function prepareStepAutomations(d1: Database, input: {
  rules: readonly StepAutomationRule[];
  trigger: AutomationTrigger;
  context: AutomationContext;
  /** Sufixo da chave de idempotência, quando o fato é mais fino que a etapa. */
  keySuffix?: string;
}) {
  const { context, trigger } = input;
  const statements: ReturnType<Database["prepare"]>[] = [];
  const events: { name: DomainEventName; payload: Record<string, unknown> }[] = [];

  for (const [index, rule] of automationsFor(input.rules, trigger).entries()) {
    if (rule.action === "create_task") {
      /* A tarefa nasce na etapa atual e na área que a automação nomeia — é o
         "criar tarefa em outra área" do §27. Ela não bloqueia o avanço: uma
         automação que trava a etapa que a disparou é um laço, e quem desenhou
         a automação não pediu isso. Quem quer bloqueio escreve a tarefa no
         desenho da etapa, onde `blocksAdvance` é explícito.

         `ON CONFLICT DO NOTHING` sobre a chave estável impede a segunda
         execução do mesmo gatilho de duplicar a tarefa (§82). */
      const key = `auto:${trigger}:${index}`;
      statements.push(d1.prepare(
        `INSERT INTO fdp_checklist_items
           (id, workspace_id, card_id, title, completed, position, process_step_id,
            template_key, area_id, required, blocks_advance)
         SELECT gen_random_uuid()::text, ?, ?, ?, 0,
                COALESCE((SELECT MAX(position) FROM fdp_checklist_items
                           WHERE workspace_id = ? AND card_id = ?), 0) + 1000,
                ?, ?, ?, 0, 0
          WHERE NOT EXISTS (
            SELECT 1 FROM fdp_checklist_items
             WHERE workspace_id = ? AND card_id = ? AND template_key = ?)`,
      ).bind(
        context.workspaceId, context.cardId, cleanText(rule.label, 200),
        context.workspaceId, context.cardId,
        context.stepId, key, rule.areaId || context.fallbackAreaId || null,
        context.workspaceId, context.cardId, key,
      ));
      continue;
    }

    if (rule.action === "notify_responsible") {
      const title = cleanText(rule.label, 160)
        || `Etapa «${context.stepLabel}» pede atenção`;
      statements.push(d1.prepare(
        `INSERT INTO fdp_notifications (id, workspace_id, user_id, event_key, notification_type, title, body, card_id)
           SELECT gen_random_uuid()::text, ?, a.user_id, ?, 'automation', ?, ?, ?
             FROM fdp_card_assignees a
            WHERE a.workspace_id = ? AND a.card_id = ?
          ON CONFLICT (user_id, event_key) DO NOTHING`,
      ).bind(
        context.workspaceId,
        automationEventKey(trigger, context, input.keySuffix),
        title,
        `Automação da etapa «${context.stepLabel}».`,
        context.cardId, context.workspaceId, context.cardId,
      ));
      continue;
    }

    if (rule.action === "record_event") {
      // `parseStepAutomations` já recusou nome fora do catálogo; a guarda aqui
      // é para o caso de a regra ter vindo de outro caminho de leitura.
      if (!rule.eventName) continue;
      events.push({
        name: rule.eventName,
        payload: {
          cardId: context.cardId,
          stepId: context.stepId,
          stepLabel: context.stepLabel,
          trigger,
          processDefinitionId: context.processDefinitionId ?? "",
          processVersionId: context.processVersionId ?? "",
        },
      });
    }
  }

  return { statements, events };
}

/* -------------------------------------------------------------------------- *
 * Varredura de tarefa vencida (§27)
 * -------------------------------------------------------------------------- */

/**
 * "Tarefa vencida → notificar responsável".
 *
 * Este é o único gatilho do §27 que não tem uma requisição para pendurar: nada
 * acontece no instante em que um prazo passa. Ele roda na varredura agendada
 * que já existe para as integrações, junto do resto — um cron novo só para isto
 * seria mais uma coisa para alguém esquecer de configurar.
 *
 * A idempotência não é opcional aqui. A varredura roda a cada ciclo e a tarefa
 * continua vencida no ciclo seguinte; sem o índice único
 * `(user_id, event_key)` de `fdp_notifications`, uma tarefa esquecida por uma
 * semana renderia um aviso por ciclo até alguém desligar o cron. A chave carrega
 * o id da tarefa: dois vencimentos diferentes são dois avisos, o mesmo
 * vencimento relido é um só (§82).
 */
export async function sweepOverdueTasks(
  d1: Database, workspaceId: string, options: { limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(200, options.limit ?? 100));

  /* Só tarefa de etapa, de demanda viva. Item solto (`process_step_id = ''`) é
     o que a pessoa adiciona à mão e o que a demanda legada tem: ele não vem de
     desenho nenhum, então não há automação declarada para ele. */
  const overdue = await d1.prepare(`SELECT ci.id, ci.card_id, ci.title, ci.process_step_id,
        c.process_version_id, c.process_definition_id
      FROM fdp_checklist_items ci
      JOIN fdp_cards c ON c.workspace_id = ci.workspace_id AND c.id = ci.card_id
     WHERE ci.workspace_id = ?
       AND ci.completed = 0 AND ci.due_at IS NOT NULL AND ci.due_at < CURRENT_TIMESTAMP
       AND ci.process_step_id <> ''
       AND c.archived = 0 AND c.closed_at IS NULL AND c.process_version_id IS NOT NULL
     ORDER BY ci.due_at LIMIT ?`)
    .bind(workspaceId, limit).all<Record<string, unknown>>();
  if (overdue.results.length === 0) return { scanned: 0, notified: 0 };

  /* As configurações das etapas envolvidas, em uma consulta.
     O recorte repete as condições acima como subconsulta em vez de receber uma
     lista de ids: passar array por parâmetro exigiria uma forma de bind que o
     resto do produto não usa, e montar a lista na string seria SQL interpolada
     numa consulta que carrega id de tenant. */
  const configs = await d1.prepare(`SELECT process_version_id, bpmn_element_id,
        automations_json, settings_json, department_id, responsible_department_id
      FROM fdp_process_step_configs
     WHERE workspace_id = ?
       AND process_version_id IN (
         SELECT DISTINCT c.process_version_id FROM fdp_cards c
          WHERE c.workspace_id = ? AND c.archived = 0 AND c.closed_at IS NULL
            AND c.process_version_id IS NOT NULL)`)
    .bind(workspaceId, workspaceId).all<Record<string, unknown>>();

  const byStep = new Map<string, Record<string, unknown>>();
  for (const row of configs.results) {
    byStep.set(`${String(row.process_version_id)}::${String(row.bpmn_element_id)}`, row);
  }

  const statements: ReturnType<Database["prepare"]>[] = [];
  for (const task of overdue.results) {
    const config = byStep.get(`${String(task.process_version_id)}::${String(task.process_step_id)}`);
    if (!config) continue;
    const rules = parseStepAutomations(config.automations_json);
    if (!rules.length) continue;
    const settings = config.settings_json && typeof config.settings_json === "object"
      ? config.settings_json as Record<string, unknown>
      : {};

    const prepared = prepareStepAutomations(d1, {
      rules, trigger: "task_overdue",
      // O sufixo é o id da tarefa: é ele que separa dois vencimentos diferentes
      // na mesma etapa sem deixar o mesmo vencimento avisar duas vezes.
      keySuffix: String(task.id),
      context: {
        workspaceId,
        cardId: String(task.card_id),
        stepId: String(task.process_step_id),
        stepLabel: String(settings.name ?? "") || String(task.title ?? ""),
        fallbackAreaId: String(config.responsible_department_id ?? "")
          || String(config.department_id ?? "") || null,
        processDefinitionId: String(task.process_definition_id ?? ""),
        processVersionId: String(task.process_version_id ?? ""),
      },
    });
    statements.push(...prepared.statements);
  }

  if (statements.length) await d1.batch(statements);
  return { scanned: overdue.results.length, notified: statements.length };
}
