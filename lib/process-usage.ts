/**
 * O processo em texto, e o que ele produziu (§39, §40, §43, §55).
 *
 * ## Por que existe uma leitura textual do desenho
 *
 * O BPMN é a linguagem de quem **modela**. Quem opera precisa saber qual é a
 * etapa, quem responde por ela, o que ela exige e o que vem depois — e obrigar
 * essa pessoa a ler um diagrama para descobrir isso é transferir a ela um
 * trabalho que o produto deveria fazer. O diagrama continua onde sempre esteve,
 * para quem desenha; esta é a mesma informação em forma de lista (§43).
 *
 * ## O que este módulo não faz
 *
 * Ele não decide nada. A ordem das etapas sai do grafo já publicado, os
 * requisitos saem da configuração já gravada, e as métricas são contagens sobre
 * as demandas que existem. Nenhuma regra de transição mora aqui — quem autoriza
 * avanço continua sendo `process-instances`, que a rota chama do zero a cada
 * pedido.
 */
import { allowedTargets, initialStepId, isTerminalStep, stepLabel, type BpmnGraph } from "./bpmn-graph.ts";
import type { ProcessStepConfig, PublishedProcessVersion } from "./process-instances.ts";

export type ProcessStepSummary = {
  id: string;
  label: string;
  /** Posição na leitura textual — 1 é a etapa inicial. */
  position: number;
  role: string;
  terminal: boolean;
  /** Quem responde: pessoa, área ou "quem pegar". */
  responsible: string;
  slaLabel: string;
  checklist: string[];
  requiredDocuments: string[];
  evidenceRequired: boolean;
  requiresApproval: boolean;
  instructions: string;
  /** Para onde o desenho autoriza ir a partir daqui. */
  nextLabels: string[];
};

const SLA_UNIT_LABELS: Record<string, string> = {
  minutes: "minuto", hours: "hora", days: "dia", business_days: "dia útil",
};

function slaLabel(config: ProcessStepConfig | null) {
  if (!config || !config.slaValue) return "Sem prazo próprio";
  const unit = SLA_UNIT_LABELS[config.slaUnit] ?? config.slaUnit;
  const plural = config.slaValue === 1 ? unit : `${unit}s`;
  return `${config.slaValue} ${plural}${config.slaBusinessDays ? " úteis" : ""}`;
}

function responsibleLabel(config: ProcessStepConfig | null, names: {
  users: ReadonlyMap<string, string>; areas: ReadonlyMap<string, string>;
}) {
  if (!config) return "Sem responsável definido";
  if (config.responsibilityMode === "USER" && config.responsibleUserId) {
    return names.users.get(config.responsibleUserId) ?? "Pessoa específica";
  }
  if (config.responsibilityMode === "DEPARTMENT" && config.departmentId) {
    return names.areas.get(config.departmentId) ?? "Área específica";
  }
  return "Qualquer pessoa com acesso";
}

/**
 * As etapas na ordem em que se percorre o processo.
 *
 * A ordem vem de uma travessia em largura a partir do início, e não da ordem do
 * XML: um diagrama desenhado de trás para frente continua produzindo a leitura
 * certa. Etapas que a travessia não alcança entram no fim — elas existem no
 * desenho e esconder isso faria a lista mentir sobre o processo.
 */
export function orderedSteps(graph: BpmnGraph): string[] {
  const first = initialStepId(graph);
  const visited = new Set<string>();
  const order: string[] = [];
  const queue = first ? [first] : [];

  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    order.push(current);
    for (const next of allowedTargets(graph, current)) if (!visited.has(next)) queue.push(next);
  }

  for (const node of graph.nodes.values()) {
    // O evento de início não é etapa de trabalho; os demais órfãos entram.
    if (visited.has(node.id) || node.role === "start") continue;
    order.push(node.id);
  }
  return order;
}

export function summarizeSteps(version: PublishedProcessVersion, names: {
  users: ReadonlyMap<string, string>; areas: ReadonlyMap<string, string>;
}): ProcessStepSummary[] {
  const byElement = new Map<string, ProcessStepConfig>();
  for (const config of version.steps.values()) {
    if (config.bpmnElementId) byElement.set(config.bpmnElementId, config);
  }

  return orderedSteps(version.graph).map((id, index) => {
    const config = version.steps.get(id) ?? byElement.get(id) ?? null;
    const node = version.graph.nodes.get(id);
    return {
      id,
      label: config?.name || stepLabel(version.graph, id),
      position: index + 1,
      role: node?.role ?? "task",
      terminal: isTerminalStep(version.graph, id),
      responsible: responsibleLabel(config, names),
      slaLabel: slaLabel(config),
      checklist: config?.checklist ?? [],
      requiredDocuments: config?.requiredDocuments ?? [],
      evidenceRequired: Boolean(config?.evidenceRequired),
      requiresApproval: Boolean(config?.requiresApproval),
      instructions: config?.instructions ?? "",
      nextLabels: allowedTargets(version.graph, id).map((target) => {
        const next = version.steps.get(target);
        return next?.name || stepLabel(version.graph, target);
      }),
    } satisfies ProcessStepSummary;
  });
}

/* -------------------------------------------------------------------------- *
 * Uso
 * -------------------------------------------------------------------------- */

export type ProcessUsage = {
  open: number;
  completed: number;
  overdue: number;
  /** Média entre abertura e conclusão, em horas. `null` quando nada concluiu. */
  averageHours: number | null;
  /** Onde as demandas abertas estão paradas — a etapa com mais gente esperando. */
  retention: Array<{ stepId: string; label: string; open: number; averageAgeHours: number }>;
};

/** Tempo em linguagem de operação: "3 dias" diz mais do que "74,2 horas". */
export function durationLabel(hours: number | null) {
  if (hours === null || !Number.isFinite(hours) || hours <= 0) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)} dias`;
}
