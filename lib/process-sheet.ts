/**
 * As abas do processo (§31): documentos, regras e automações.
 *
 * A §31 pede seis abas na ficha do processo. Três já tinham conteúdo — o fluxo
 * em texto (§43), a descrição do cadastro (§22) e o histórico de versões (§28).
 * As outras três existiam como configuração espalhada por etapa e não tinham
 * onde ser lidas: para saber quais documentos o processo cobra era preciso
 * abrir o modelador, clicar em cada etapa e somar de cabeça.
 *
 * ## O que este módulo decide, e o que não decide
 *
 * Ele **descreve**. Nenhuma regra é avaliada aqui: quem autoriza avanço continua
 * sendo `process-instances`, chamado do zero pela rota a cada pedido. Duplicar a
 * decisão criaria duas respostas para a mesma pergunta, e a ficha passaria a
 * prometer o que o servidor recusa.
 *
 * ## Por que a aba de documentos diz *como* cada documento é conferido
 *
 * Hoje o produto trata documento obrigatório como item de checklist: marcar é
 * declarar, não provar. Só `evidenceRequired` olha se existe anexo — e por
 * contagem total da demanda, não por documento. Esconder essa diferença faria a
 * ficha prometer uma conferência que não acontece; quem lê precisa saber se a
 * exigência é verificada ou apenas declarada, porque é isso que decide se a
 * auditoria confia na etapa. Enquanto o DP não decidir mudar a regra, a tela
 * conta a verdade sobre ela.
 */
import { describeCondition, FACT_LABELS } from "./process-conditions.ts";
import type { ProcessStepConfig, PublishedProcessVersion } from "./process-instances.ts";
import { orderedSteps } from "./process-usage.ts";
import { stepLabel } from "./bpmn-graph.ts";

/** Colunas de etapa que o motor não carrega, porque não decide com elas. */
export type StepAutomationRow = {
  bpmnElementId: string;
  createDemand: boolean;
  demandType: string;
  demandPriority: string;
  demandSlaValue: number;
  demandSlaUnit: string;
  requesterDepartmentId: string;
  responsibleDepartmentId: string;
  optionalDocuments: string[];
};

export type NameMaps = { users: ReadonlyMap<string, string>; areas: ReadonlyMap<string, string> };

/* -------------------------------------------------------------------------- *
 * Documentos (§26)
 * -------------------------------------------------------------------------- */

export type DocumentRequirement = {
  name: string;
  required: boolean;
  /** Rótulo das etapas que pedem este documento, na ordem do processo. */
  steps: string[];
  /**
   * Como a exigência é conferida hoje.
   *
   * `evidence` significa que a etapa recusa avanço sem anexo; `declared`
   * significa que basta marcar o item. A distinção é o §26 em aberto.
   */
  proof: "evidence" | "declared";
};

const PRIORITY_LABELS: Record<string, string> = {
  low: "baixa", normal: "normal", high: "alta", urgent: "urgente",
};

const SLA_UNITS: Record<string, string> = { minutes: "minuto", hours: "hora", days: "dia" };

const clean = (value: unknown) => String(value ?? "").trim();

/** Chave de agrupamento: o mesmo documento escrito em caixas diferentes é um só. */
const documentKey = (name: string) => name.trim().toLocaleLowerCase("pt-BR");

/**
 * Cada documento que o processo cobra, e em que etapas.
 *
 * Agrupar por documento, e não por etapa, é o que responde a pergunta de quem
 * abre a aba: "o que preciso juntar para esta admissão andar?". A lista por
 * etapa já existe no fluxo.
 */
export function summarizeDocuments(
  version: PublishedProcessVersion,
  automation: ReadonlyMap<string, StepAutomationRow> = new Map(),
): DocumentRequirement[] {
  const byDocument = new Map<string, DocumentRequirement>();

  for (const id of orderedSteps(version.graph)) {
    const config = version.steps.get(id);
    const label = config?.name || stepLabel(version.graph, id);
    const extra = automation.get(id);
    const entries: Array<{ name: string; required: boolean }> = [
      ...(config?.requiredDocuments ?? []).map((name) => ({ name, required: true })),
      ...(extra?.optionalDocuments ?? []).map((name) => ({ name, required: false })),
    ];

    for (const entry of entries) {
      const name = clean(entry.name);
      if (!name) continue;
      const key = documentKey(name);
      const current = byDocument.get(key);
      // A etapa que exige anexo manda na leitura: se qualquer etapa confere de
      // verdade, dizer "apenas declarado" subestimaria o processo.
      const proof = entry.required && config?.evidenceRequired ? "evidence" : "declared";
      if (!current) {
        byDocument.set(key, { name, required: entry.required, steps: [label], proof });
        continue;
      }
      if (!current.steps.includes(label)) current.steps.push(label);
      if (entry.required) current.required = true;
      if (proof === "evidence") current.proof = "evidence";
    }
  }

  return [...byDocument.values()];
}

/* -------------------------------------------------------------------------- *
 * Regras e validações (§25)
 * -------------------------------------------------------------------------- */

export type StepRules = {
  stepId: string;
  label: string;
  position: number;
  /** Condições para a demanda **entrar** nesta etapa (§23). */
  entry: string[];
  /** Condições para **sair** desta etapa (§23). */
  exit: string[];
  /** Condição por destino: "só segue para X se…". */
  transitions: Array<{ target: string; conditions: string[] }>;
  /** O que a etapa exige antes de ser dada por concluída (§25). */
  requirements: string[];
  /** Canais cuja falha trava a conclusão (§25). */
  blockingIntegrations: string[];
};

function stepRequirements(config: ProcessStepConfig | undefined, names: NameMaps): string[] {
  if (!config) return [];
  const list: string[] = [];
  if (config.checklist.length) {
    list.push(`Não avança com item de checklist pendente (${config.checklist.length})`);
  }
  if (config.requiredDocuments.length) {
    list.push(`Exige ${config.requiredDocuments.length} documento(s): ${config.requiredDocuments.join(", ")}`);
  }
  if (config.evidenceRequired) list.push("Exige anexo na demanda antes de concluir");
  if (config.requiresApproval) {
    const approver = config.approverUserId
      ? names.users.get(config.approverUserId) ?? "pessoa específica"
      : config.approverDepartmentId
        ? names.areas.get(config.approverDepartmentId) ?? "área específica"
        : "";
    // Quem aprova não pode ser quem executou: a recusa existe no motor, e dizer
    // isso aqui evita que alguém desenhe uma aprovação que nunca vai passar.
    list.push(approver ? `Exige aprovação de ${approver}, que não pode ser quem executou` : "Exige aprovação de outra pessoa");
  }
  return list;
}

/**
 * As regras de cada etapa, em português.
 *
 * Etapas sem nenhuma regra saem da lista: uma tabela com quinze linhas vazias
 * esconde as três que importam.
 */
export function summarizeRules(version: PublishedProcessVersion, names: NameMaps): StepRules[] {
  const rules: StepRules[] = [];

  orderedSteps(version.graph).forEach((id, index) => {
    const config = version.steps.get(id);
    const transitions: StepRules["transitions"] = [];

    for (const flow of version.graph.flows) {
      if (flow.source !== id) continue;
      const conditions = config?.transitions[flow.id] ?? [];
      if (!conditions.length) continue;
      const target = version.steps.get(flow.target)?.name || stepLabel(version.graph, flow.target);
      transitions.push({ target, conditions: conditions.map(describeCondition) });
    }

    const entry = (config?.entryRules ?? []).map(describeCondition);
    const exit = (config?.exitRules ?? []).map(describeCondition);
    const requirements = stepRequirements(config, names);
    const blockingIntegrations = [...(config?.blockingIntegrations ?? [])];

    if (!entry.length && !exit.length && !transitions.length && !requirements.length && !blockingIntegrations.length) {
      return;
    }
    rules.push({
      stepId: id,
      label: config?.name || stepLabel(version.graph, id),
      position: index + 1,
      entry, exit, transitions, requirements, blockingIntegrations,
    });
  });

  return rules;
}

/** Os fatos que uma condição pode citar, para a tela explicar o vocabulário. */
export function conditionFactLabels(): Array<{ field: string; label: string }> {
  return Object.entries(FACT_LABELS).map(([field, label]) => ({ field, label }));
}

/* -------------------------------------------------------------------------- *
 * Automações (§27)
 * -------------------------------------------------------------------------- */

export type StepAutomation = {
  stepId: string;
  label: string;
  position: number;
  trigger: string;
  effect: string;
};

function slaPhrase(value: number, unit: string) {
  if (!value) return "";
  const word = SLA_UNITS[unit] ?? unit;
  return `prazo de ${value} ${value === 1 ? word : `${word}s`}`;
}

/**
 * O que o processo dispara sozinho.
 *
 * Só entra o que o produto realmente executa: a criação de demanda configurada
 * na etapa. O encadeamento "etapa concluída → próxima etapa" é o desenho, e já
 * é lido na aba de fluxo; repeti-lo aqui como automação faria a aba parecer
 * cheia sem acrescentar nada. As regras de quadro (mover, etiquetar, prazo) são
 * do workspace e não pertencem a um processo — a tela diz onde elas moram em
 * vez de fingir que são deste processo.
 */
export function summarizeAutomations(
  version: PublishedProcessVersion,
  automation: ReadonlyMap<string, StepAutomationRow>,
  names: NameMaps,
): StepAutomation[] {
  const list: StepAutomation[] = [];

  orderedSteps(version.graph).forEach((id, index) => {
    const row = automation.get(id);
    if (!row?.createDemand) return;
    const config = version.steps.get(id);
    const area = row.responsibleDepartmentId ? names.areas.get(row.responsibleDepartmentId) : "";
    const parts = [
      `abre demanda${row.demandType ? ` de ${row.demandType}` : ""}`,
      area ? `para ${area}` : "",
      `prioridade ${PRIORITY_LABELS[row.demandPriority] ?? row.demandPriority}`,
      slaPhrase(row.demandSlaValue, row.demandSlaUnit),
    ].filter(Boolean);

    list.push({
      stepId: id,
      label: config?.name || stepLabel(version.graph, id),
      position: index + 1,
      trigger: `Ao chegar em «${config?.name || stepLabel(version.graph, id)}»`,
      effect: parts.join(", "),
    });
  });

  return list;
}
