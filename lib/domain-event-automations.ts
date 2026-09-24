/**
 * Motor de Jornadas — passo 1: evento de domínio inicia processo sozinho.
 *
 * Até aqui, uma versão publicada só virava demanda quando alguém clicava em
 * "iniciar processo" (`app/api/processes/versions/[id]/instantiate/route.ts`).
 * O catálogo de eventos de domínio (`lib/domain-events.ts`) já descreve fatos
 * como `employee.admitted` ou `termination.requested`, mas nenhuma regra os
 * alcançava — o motor de automação (`lib/automation-rules.ts`) só escutava
 * eventos de **cartão**, que pressupõem um cartão que já existe.
 *
 * Este módulo é o elo que faltava: quando um evento de domínio é registrado, as
 * regras `domain_event` do workspace são avaliadas, e a que combinar com o
 * evento **e** tiver a ação `instantiateProcessVersionId` inicia a versão
 * publicada — pela mesma função (`prepareProcessInstance`) e com as mesmas
 * garantias da instanciação manual: checklist da etapa inicial, prazo
 * calculado, e o evento `process.instance_started` gravado com a chave de
 * idempotência que impede a segunda ocorrência de abrir uma segunda demanda.
 *
 * ## Por que isto não devolve *statements* como o resto do motor de processo
 *
 * `prepareProcessInstance` devolve statements porque quem chama já está dentro
 * do lote da mutação que a disparou (o exemplo é a própria instanciação manual,
 * que grava tudo — cartão, atividade, evento, auditoria — numa transação só).
 *
 * Aqui o fato que dispara (o evento de domínio) **já foi gravado** — em geral,
 * no mesmo lote da mutação que o originou (ex.: `employee.admitted` no mesmo
 * lote da criação do colaborador). A automação é uma **consequência seguinte**,
 * não parte daquele fato: se instanciar o processo falhar, o colaborador
 * continua existindo — o contrário derrubaria um cadastro por causa de uma
 * automação. Por isso cada regra que combina roda no próprio lote, e a falha
 * de uma regra (ou de várias, se houver mais de uma para o mesmo evento) nunca
 * derruba o fato original nem as demais regras.
 *
 * ## O que isto deliberadamente não faz
 *
 * - Não decide **quando** um evento de domínio nasce — isso é de cada emissor
 *   (`lib/outbox.ts`, os conectores). Este módulo só reage ao que já existe.
 * - Não move etapa de processo nenhuma: ele só **inicia**. Mover continua
 *   exigindo o ator humano que `lib/process-instances.ts` exige (§16).
 * - Não interpreta o payload do evento além de `entityId`, `companyId` e
 *   `employeeId` — os únicos campos genéricos o bastante para valer para
 *   qualquer evento do catálogo. Mapeamento mais rico é trabalho de UI futuro.
 */
import type { getD1 } from "../db";

import { ApiError } from "./api-errors.ts";
import { matchesDomainEventRule } from "./domain-event-conditions.ts";
import { deriveIdempotencyKey, type DomainEventName } from "./domain-events.ts";
import { prepareActivity, prepareAuditEvent } from "./fila-dp-db.ts";
import { prepareAdoptionIncrement } from "./adoption-metrics.ts";
import { log } from "./observability.ts";
import {
  findEventByIdempotencyKey, isIdempotencyConflict, prepareDomainEventEnvelope,
} from "./outbox.ts";
import { loadPublishedVersion, prepareProcessInstance } from "./process-instances.ts";

export { matchesDomainEventRule } from "./domain-event-conditions.ts";

type Database = ReturnType<typeof getD1>;

export type TriggeringDomainEvent = {
  name: DomainEventName;
  entityId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  correlationId?: string;
};

export type DomainEventAutomationActor = { userId: string; email: string };

export type DomainEventAutomationResult =
  | { outcome: "started"; ruleId: string; ruleName: string; cardId: string }
  | { outcome: "duplicate"; ruleId: string; ruleName: string; cardId: string }
  | { outcome: "skipped"; ruleId: string; ruleName: string; reason: string };

type Row = Record<string, unknown>;

function safeJson(raw: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(raw ?? "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Quadro e coluna de entrada onde a demanda automática nasce.
 *
 * Sem `boardId` na ação, resolve o quadro mais antigo do grupo — o mesmo
 * padrão que `lib/teams-integration.ts` usa para a mesma pergunta ("automação
 * sem gestor de tela para perguntar isso"). Um quadro explícito na ação vale
 * mais, porque foi a própria pessoa que configurou a regra que escolheu.
 */
async function resolveAutomationTarget(d1: Database, workspaceId: string, boardId: string) {
  const target = await d1.prepare(
    `SELECT board.id AS board_id, list.id AS list_id, list.sla_behavior
       FROM fdp_boards board
       JOIN fdp_lists list ON list.workspace_id = board.workspace_id AND list.board_id = board.id AND list.kind = 'new'
      WHERE board.workspace_id = ? AND (? = '' OR board.id = ?)
      ORDER BY board.created_at, board.name LIMIT 1`,
  ).bind(workspaceId, boardId, boardId)
    .first<{ board_id: string; list_id: string; sla_behavior: string }>();
  if (!target) return null;
  return { boardId: String(target.board_id), listId: String(target.list_id), listSlaBehavior: String(target.sla_behavior ?? "") };
}

/**
 * Avalia as regras `domain_event` do grupo contra um evento já registrado e
 * inicia a versão publicada de cada uma que combinar.
 *
 * Nunca lança: uma regra mal configurada (versão despublicada, quadro
 * removido) não pode impedir as demais regras de rodar, nem devolver erro para
 * quem só queria registrar o fato que disparou tudo isto. Cada resultado diz o
 * que aconteceu com aquela regra especificamente.
 */
export async function runDomainEventAutomations(
  d1: Database,
  workspaceId: string,
  event: TriggeringDomainEvent,
  actor: DomainEventAutomationActor,
  requestId?: string | null,
): Promise<DomainEventAutomationResult[]> {
  const rules = await d1.prepare(
    `SELECT id, name, condition_json, action_json FROM fdp_automation_rules
      WHERE workspace_id = ? AND trigger = 'domain_event' AND enabled = 1 ORDER BY position`,
  ).bind(workspaceId).all<Row>();
  if (!rules.results.length) return [];

  const results: DomainEventAutomationResult[] = [];
  for (const rule of rules.results) {
    const ruleId = String(rule.id);
    const ruleName = String(rule.name);
    const condition = safeJson(rule.condition_json);
    if (!matchesDomainEventRule(condition, event)) continue;

    const action = safeJson(rule.action_json);
    const processVersionId = typeof action.instantiateProcessVersionId === "string" ? action.instantiateProcessVersionId : "";
    if (!processVersionId) {
      results.push({ outcome: "skipped", ruleId, ruleName, reason: "ação sem versão de processo para iniciar" });
      continue;
    }

    // A chave carrega a regra e o evento que disparou: a mesma ocorrência não
    // inicia duas vezes, e duas regras diferentes para o mesmo evento não
    // colidem entre si.
    const idempotencyKey = deriveIdempotencyKey({
      workspaceId, name: "process.instance_started", origin: "internal",
      externalId: `automation:${ruleId}:${event.idempotencyKey}`,
    });
    const existing = await findEventByIdempotencyKey(d1, workspaceId, idempotencyKey);
    if (existing?.entity_id) {
      results.push({ outcome: "duplicate", ruleId, ruleName, cardId: String(existing.entity_id) });
      continue;
    }

    let version;
    try {
      version = await loadPublishedVersion(d1, workspaceId, processVersionId);
    } catch (error) {
      results.push({
        outcome: "skipped", ruleId, ruleName,
        reason: error instanceof ApiError ? error.message : "versão de processo indisponível",
      });
      continue;
    }

    const target = await resolveAutomationTarget(d1, workspaceId, typeof action.boardId === "string" ? action.boardId : "");
    if (!target) {
      results.push({ outcome: "skipped", ruleId, ruleName, reason: "nenhum quadro com coluna de entrada disponível" });
      continue;
    }

    const companyId = typeof event.payload.companyId === "string" && event.payload.companyId ? event.payload.companyId : null;
    const employeeId = event.entityId || (typeof event.payload.employeeId === "string" ? event.payload.employeeId : "") || null;

    const { statements, result } = await prepareProcessInstance(d1, {
      workspaceId,
      version,
      actor,
      boardId: target.boardId,
      listId: target.listId,
      listSlaBehavior: target.listSlaBehavior,
      title: `${version.definitionName} — ${ruleName}`,
      companyId,
      employeeId,
      requesterUserId: actor.userId,
      sourceType: "automation",
      trigger: event.name,
      idempotencyKey,
      correlationId: event.correlationId,
      requestId: requestId ?? null,
    });

    try {
      await d1.batch([
        ...statements,
        prepareActivity(workspaceId, result.cardId, actor.email, "process.instance_started", {
          processId: version.definitionId, versionId: version.versionId,
          versionNumber: result.versionNumber, stepId: result.stepId, stepLabel: result.stepLabel,
          trigger: event.name, ruleId, ruleName,
        }),
        prepareDomainEventEnvelope(d1, {
          name: "process.instance_started",
          origin: "internal",
          workspaceId,
          entityId: result.cardId,
          idempotencyKey,
          correlationId: event.correlationId,
          payload: {
            processDefinitionId: version.definitionId,
            processVersionId: version.versionId,
            processVersionNumber: result.versionNumber,
            currentStepId: result.stepId,
            cardId: result.cardId,
            companyId: companyId ?? "",
            trigger: event.name,
          },
        }, { actorUserId: actor.userId, requestId: requestId ?? null, onConflict: "raise" }),
        prepareAdoptionIncrement(d1, workspaceId, "demands_from_process"),
        prepareAuditEvent({
          workspaceId, actorUserId: actor.userId, actorEmail: actor.email,
          action: "process.instance_started", entityType: "card", entityId: result.cardId,
          after: {
            processDefinitionId: version.definitionId, processVersionId: version.versionId,
            processVersionNumber: result.versionNumber, currentStepId: result.stepId,
          },
          metadata: { trigger: event.name, ruleId, ruleName },
          requestId: requestId ?? null,
        }),
      ]);
      results.push({ outcome: "started", ruleId, ruleName, cardId: result.cardId });
    } catch (error) {
      // Concorrência: outra execução da mesma ocorrência venceu a corrida no
      // meio deste lote. A transação desta foi desfeita inteira — não existe
      // demanda órfã para limpar, e a que já existe é a resposta certa.
      if (isIdempotencyConflict(error)) {
        const winner = await findEventByIdempotencyKey(d1, workspaceId, idempotencyKey);
        results.push(winner?.entity_id
          ? { outcome: "duplicate", ruleId, ruleName, cardId: String(winner.entity_id) }
          : { outcome: "skipped", ruleId, ruleName, reason: "conflito de idempotência sem demanda localizável" });
        continue;
      }
      // Qualquer outra falha (SLA sem feriados configurados, área removida…) é
      // desta regra, não do fato que a disparou. O documento no topo do
      // arquivo promete "nunca lança" — é aqui que a promessa é cumprida: a
      // próxima regra ainda roda, e quem chamou ainda recebe uma resposta.
      log("warn", "domain_event_automation.rule_failed", { workspaceId }, {
        ruleId, ruleName, event: event.name,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
      });
      results.push({ outcome: "skipped", ruleId, ruleName, reason: "falha ao iniciar o processo — ver log" });
    }
  }
  return results;
}
