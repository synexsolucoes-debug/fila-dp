/**
 * Motor determinístico de processo: instanciação e transição de etapa.
 *
 * Este arquivo é a resposta ao achado central da auditoria — *o BPMN existe, mas
 * não executa trabalho*. Antes dele havia dois conceitos paralelos de processo:
 * a Biblioteca versionada e publicável (`fdp_process_definitions` /
 * `fdp_process_versions`) e os modelos antigos de checklist
 * (`fdp_process_templates`) que Demandas realmente usava. Publicar uma versão
 * não produzia nada.
 *
 * O que passa a valer:
 *
 *   Processo   = definição versionada do trabalho.
 *   Versão     = o desenho publicado, imutável para quem já o segue.
 *   Demanda    = instância operacional de uma versão.
 *   Etapa      = onde a instância está agora, dentro daquela versão.
 *
 * Três regras que o código impõe, e não apenas documenta:
 *
 * 1. **A demanda fica presa à versão que a originou** (§11). Publicar a v5 não
 *    move nada da v4. Isso não depende de disciplina: a chave estrangeira sem
 *    `ON DELETE` e a coluna `process_version_id` da própria demanda garantem.
 *
 * 2. **Ninguém troca de etapa por `UPDATE` direto** (§15). A transição passa por
 *    `transitionProcessStep`, que confere versão, etapa atual, destino
 *    autorizado pelo desenho, requisitos da etapa, permissão, responsável,
 *    bloqueio e idempotência — nessa ordem, e recusando na primeira que falhar.
 *
 * 3. **Agente não move processo** (§16). Este módulo não conhece agente nenhum;
 *    quem propõe passa por `lib/agent-proposals.ts`, que só chega aqui depois de
 *    o motor aceitar. A assinatura exige um ator humano identificado.
 *
 * Demanda legada (sem versão) continua funcionando e **não** é convertida
 * automaticamente (§13): converter histórico sem regra comprovada inventaria
 * vínculo, e vínculo inventado em DP vira erro trabalhista.
 */
import type { getD1 } from "../db";

import { ApiError } from "./api-errors.ts";
import {
  allowedTargets, initialStepId, isTerminalStep, outgoingFlows, parseBpmnGraph, stepLabel,
  type BpmnGraph,
} from "./bpmn-graph.ts";
import { addBusinessDays } from "./fila-dp-relations.ts";
import { cleanText } from "./registrations.ts";
import {
  describeCondition, parseConditionList, parseTransitionConditions, unmetConditions,
  type ConditionFacts, type TransitionCondition, type TransitionConditionMap,
} from "./process-conditions.ts";
import {
  describeMissingDocuments, missingDocuments, parseDocumentProof, type DocumentProof,
} from "./process-documents.ts";
import {
  parseStepAutomations, parseTaskTemplates, taskDeadline, taskKey,
  type StepAutomationRule, type TaskTemplate,
} from "./process-tasks.ts";

type Database = ReturnType<typeof getD1>;
type Row = Record<string, unknown>;

const text = (value: unknown) => (value == null ? "" : String(value));
const flag = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";

export type ProcessStepConfig = {
  id: string;
  bpmnElementId: string;
  stepType: string;
  name: string;
  instructions: string;
  departmentId: string;
  responsibleUserId: string;
  responsibilityMode: string;
  slaValue: number;
  slaUnit: string;
  slaBusinessDays: boolean;
  requesterDepartmentId: string;
  responsibleDepartmentId: string;
  checklist: string[];
  requiredDocuments: string[];
  evidenceRequired: boolean;
  requiresApproval: boolean;
  approverUserId: string;
  approverDepartmentId: string;
  demandPriority: string;
  /** Condições por seta que sai desta etapa (§25). Vazio = seta incondicional. */
  transitions: TransitionConditionMap;
  /** Condições para **entrar** nesta etapa (§23). Medidas ao chegar. */
  entryRules: TransitionCondition[];
  /** Condições para **sair** desta etapa (§23). Medidas ao tentar avançar. */
  exitRules: TransitionCondition[];
  /**
   * Canais de integração que precisam estar sãos para a etapa avançar (§25).
   *
   * Uma etapa que depende do ERP não deveria ser marcada como concluída
   * enquanto a sincronização está quebrada: o trabalho não chegou do outro
   * lado, e dar por feito cria divergência que só aparece na conferência.
   */
  blockingIntegrations: string[];
  /**
   * Como a etapa confere os documentos que exige (§26).
   *
   * `declared` — o padrão — é o comportamento de sempre: documento obrigatório
   * é item de checklist, e marcar basta. `attached` cobra um anexo por
   * documento. A escolha é da etapa porque ligar a conferência para todo mundo
   * pararia demanda que hoje anda.
   */
  documentProof: DocumentProof;
  /**
   * Tarefas-modelo da etapa (§24).
   *
   * Sempre preenchido: quando a etapa não desenhou tarefas, cada título de
   * `checklist` vira uma tarefa obrigatória e bloqueante — que é o significado
   * que o motor já dava a um item de checklist.
   */
  tasks: TaskTemplate[];
  /** Automações declaradas da etapa (§27). */
  automations: StepAutomationRule[];
};

/**
 * O que `stepTasks` precisa saber para derivar as tarefas de uma etapa.
 *
 * Parcial de propósito: além da configuração inteira que a execução carrega, há
 * chamadores que só têm parte dela — teste que monta a estrutura à mão, tela que
 * pré-visualiza uma etapa antes de gravá-la. Aceitar a parcial no tipo é o que
 * impede o `as` no chamador, e foi um `as` que escondeu do compilador a
 * configuração sem `tasks` que derrubava o painel em produção.
 */
export type StepTaskSource = Partial<ProcessStepConfig>;

export type DemandStageSnapshot = {
  bpmnElementId: string;
  title: string;
  position: number;
  processStepConfigId: string | null;
  responsibleAreaId: string | null;
  responsibleUserId: string | null;
  config: ProcessStepConfig | null;
};

export type PublishedProcessVersion = {
  definitionId: string;
  definitionName: string;
  definitionCode: string;
  isCorporate: boolean;
  defaultPriority: string;
  versionId: string;
  versionNumber: string;
  bpmnXml: string;
  graph: BpmnGraph;
  steps: Map<string, ProcessStepConfig>;
};

/**
 * Lê a configuração de uma etapa a partir da linha de `fdp_process_step_configs`.
 *
 * Exportada porque a leitura da linha é a definição de o que a etapa é: quem
 * precisar contar, listar ou instanciar as tarefas de uma versão parte daqui,
 * em vez de reconstruir a mesma tradução a partir de um subconjunto das colunas
 * — que foi como o total previsto do painel passou a ler `checklist` de dentro
 * de `settings_json`, onde ele nunca esteve.
 */
export function stepConfigOf(row: Row): ProcessStepConfig {
  const settings = row.settings_json && typeof row.settings_json === "object"
    ? row.settings_json as Row
    : (() => { try { return JSON.parse(text(row.settings_json) || "{}") as Row; } catch { return {}; } })();
  const list = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((item) => cleanText(item, 200)).filter(Boolean);
    try {
      const parsed = JSON.parse(text(value) || "[]") as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => cleanText(item, 200)).filter(Boolean) : [];
    } catch { return []; }
  };
  return {
    id: text(row.id),
    bpmnElementId: text(row.bpmn_element_id),
    stepType: text(row.step_type) || "TASK",
    name: cleanText(settings.name, 160),
    instructions: cleanText(settings.instructions, 4000),
    departmentId: text(row.department_id),
    responsibleUserId: text(row.responsible_user_id),
    responsibilityMode: text(row.responsibility_mode) || "DEPARTMENT",
    slaValue: Number(row.sla_value ?? 0),
    slaUnit: text(row.sla_unit) || "hours",
    slaBusinessDays: flag(row.sla_business_days),
    requesterDepartmentId: text(row.requester_department_id),
    responsibleDepartmentId: text(row.responsible_department_id),
    checklist: list(row.checklist_json),
    requiredDocuments: list(row.required_documents_json),
    evidenceRequired: flag(row.evidence_required),
    requiresApproval: flag(row.requires_approval),
    approverUserId: text(row.approver_user_id),
    approverDepartmentId: text(row.approver_department_id),
    demandPriority: text(row.demand_priority) || "normal",
    transitions: parseTransitionConditions(settings.transitions),
    entryRules: parseConditionList(settings.entryRules),
    exitRules: parseConditionList(settings.exitRules),
    blockingIntegrations: list(settings.blockingIntegrations).map((item) => item.toLowerCase()),
    documentProof: parseDocumentProof(settings.documentProof),
    tasks: parseTaskTemplates({ tasksJson: row.tasks_json, checklist: list(row.checklist_json) }),
    automations: parseStepAutomations(row.automations_json),
  };
}

/**
 * Carrega uma versão **publicada** e a torna executável.
 *
 * Recusar rascunho aqui, e não na rota, é o que impede o caminho lateral: uma
 * automação futura que chame o motor direto encontra a mesma recusa que a tela.
 */
/**
 * Carrega uma versão para **leitura**, publicada ou não.
 *
 * A ficha do processo (§31) precisa mostrar documentos, regras e automações
 * enquanto alguém ainda está desenhando — que é justamente quando essas
 * respostas são mais úteis. Antes, um processo em rascunho abria a ficha com
 * banner vermelho de erro nas quatro abas: o produto recusava *ler* o que ele
 * mesmo mandava configurar.
 *
 * A recusa continua existindo, e no mesmo lugar: `loadPublishedVersion` é a
 * porta da **execução** e segue rejeitando rascunho. Ler e executar são coisas
 * diferentes, e separar as duas é o que permite mostrar sem permitir instanciar.
 */
export async function loadVersionForReading(
  d1: Database, workspaceId: string, versionId: string,
): Promise<PublishedProcessVersion & { published: boolean }> {
  const version = await loadVersionRow(d1, workspaceId, versionId, { requirePublished: false });
  return version as PublishedProcessVersion & { published: boolean };
}

export async function loadPublishedVersion(
  d1: Database, workspaceId: string, versionId: string,
): Promise<PublishedProcessVersion> {
  return loadVersionRow(d1, workspaceId, versionId, { requirePublished: true });
}

async function loadVersionRow(
  d1: Database, workspaceId: string, versionId: string,
  options: { requirePublished: boolean },
): Promise<PublishedProcessVersion & { published: boolean }> {
  const row = await d1.prepare(`SELECT v.id, v.definition_id, v.status, v.version_major, v.version_minor, v.bpmn_xml,
      p.name AS definition_name, p.code AS definition_code, p.is_corporate, p.default_priority, p.lifecycle_status
    FROM fdp_process_versions v
    JOIN fdp_process_definitions p ON p.workspace_id = v.workspace_id AND p.id = v.definition_id
    WHERE v.workspace_id = ? AND v.id = ?`).bind(workspaceId, versionId).first<Row>();
  if (!row) throw ApiError.notFound("Versão de processo não encontrada.", "PROCESS_VERSION_NOT_FOUND");
  const published = text(row.status) === "published";
  if (options.requirePublished && !published) {
    throw ApiError.badRequest(
      "Só uma versão publicada pode gerar demanda. Publique a versão antes de instanciá-la.",
      "PROCESS_VERSION_NOT_PUBLISHED",
    );
  }
  if (options.requirePublished && ["archived", "inactive"].includes(text(row.lifecycle_status))) {
    throw ApiError.badRequest("Este processo está arquivado ou inativo e não inicia novas demandas.", "PROCESS_NOT_STARTABLE");
  }

  const configs = await d1.prepare(
    `SELECT * FROM fdp_process_step_configs WHERE workspace_id = ? AND process_version_id = ? ORDER BY bpmn_element_id`,
  ).bind(workspaceId, versionId).all<Row>();

  const graph = parseBpmnGraph(row.bpmn_xml);
  if (graph.nodes.size === 0) {
    throw ApiError.badRequest("O diagrama desta versão não possui etapas legíveis.", "PROCESS_GRAPH_EMPTY");
  }
  return {
    definitionId: text(row.definition_id),
    definitionName: text(row.definition_name),
    definitionCode: text(row.definition_code),
    isCorporate: flag(row.is_corporate),
    defaultPriority: text(row.default_priority) || "normal",
    versionId: text(row.id),
    versionNumber: `${Number(row.version_major ?? 1)}.${Number(row.version_minor ?? 0)}`,
    bpmnXml: text(row.bpmn_xml),
    graph,
    steps: new Map(configs.results.map((config) => [text(config.bpmn_element_id), stepConfigOf(config)])),
    published,
  };
}

/** Etapa inicial da instância, com a configuração dela quando existir. */
export function resolveInitialStep(version: PublishedProcessVersion) {
  const stepId = initialStepId(version.graph);
  if (!stepId) {
    throw ApiError.badRequest(
      "O diagrama desta versão não tem um evento de início ligado a nenhuma etapa.",
      "PROCESS_START_MISSING",
    );
  }
  return { stepId, config: version.steps.get(stepId) ?? null, label: stepLabel(version.graph, stepId) };
}

/**
 * Tarefas que a etapa instancia (§24).
 *
 * As tarefas-modelo desenhadas, mais uma por documento obrigatório que nenhuma
 * delas já cobre. A tarefa gerada por documento nasce com a regra de conclusão
 * `document`: ela é a exigência, então exigir a marcação sem o arquivo seria a
 * mesma declaração vazia que §26 já tinha resolvido para a etapa.
 *
 * A dedução de duplicata é por chave, e não por título: "Documento obrigatório:
 * CPF" desenhado à mão e o gerado a partir de `requiredDocuments: ["CPF"]` são
 * a mesma tarefa, e instanciar as duas faria a pessoa marcar duas vezes.
 */
export function stepTasks(config: StepTaskSource | null): TaskTemplate[] {
  if (!config) return [];
  /* A queda para o checklist acontece **aqui**, e não só no carregador.
     `stepConfigOf` já resolve as duas fontes, mas nem toda configuração chega
     por ele: os testes montam a estrutura à mão e `lib/fila-dp-db.ts` montava
     uma parcial para contar tarefas previstas. Depender de o chamador ter
     populado `tasks` fazia a etapa com checklist e sem tarefas-modelo
     instanciar zero tarefas — silenciosamente, porque nada reclama de uma lista
     vazia.
     Ler a lista sem conferir que ela existe era pior que silencioso: a parcial
     sem `tasks` derrubava a montagem inteira do painel com um `TypeError`, e
     quem só queria abrir a tela recebia 500. Cada uma das três listas é lida
     como ausente quando o chamador não a trouxe. */
  const declared = Array.isArray(config.tasks) ? config.tasks : [];
  const checklist = Array.isArray(config.checklist) ? config.checklist : [];
  const requiredDocuments = Array.isArray(config.requiredDocuments) ? config.requiredDocuments : [];
  const tasks = declared.length
    ? [...declared]
    : parseTaskTemplates({ checklist });
  const known = new Set(tasks.map((task) => task.key));
  /* A tarefa que já declara este documento também conta como cobertura, mesmo
     com outro nome: quem desenhou "Receber ASO" com `documentRequired: "ASO"`
     não quer uma segunda tarefa dizendo a mesma coisa. */
  const covered = new Set(tasks.map((task) => taskKey(task.documentRequired)).filter(Boolean));
  for (const document of requiredDocuments) {
    const name = `Documento obrigatório: ${document}`;
    /* A chave sai do nome gerado, e não de uma composição própria. Enquanto
       eram duas fórmulas diferentes, a tarefa escrita à mão com este mesmo
       título e a gerada aqui recebiam chaves distintas e a etapa instanciava
       as duas — a pessoa marcava o mesmo documento duas vezes. */
    const key = taskKey(name);
    if (!key || known.has(key) || covered.has(taskKey(document))) continue;
    known.add(key);
    tasks.push({
      key, name,
      description: "", instructions: "",
      assigneeUserId: "", assigneeRole: "", areaId: config.responsibleDepartmentId || config.departmentId || "",
      slaValue: 0, slaUnit: "hours",
      required: true, blocksAdvance: true,
      evidenceRequired: false,
      documentRequired: document,
      /* Só quando a etapa escolheu conferir por anexo (§26). Com `declared`,
         marcar continua bastando — é o comportamento das versões publicadas, e
         apertá-lo aqui pararia demanda que hoje anda (§48). */
      completionRule: config.documentProof === "attached" ? "document" : "manual",
      dependsOn: [],
      position: (tasks.length + 1) * 1000,
    });
  }
  return tasks.slice(0, 120);
}

/**
 * Títulos das tarefas da etapa.
 *
 * Derivado de `stepTasks` de propósito: enquanto os dois eram listas separadas,
 * o total previsto do progresso ("7 de 18") e o que a execução materializava
 * podiam divergir sem ninguém notar.
 */
export function stepChecklist(config: StepTaskSource | null): string[] {
  return [...new Set(stepTasks(config).map((task) => task.name))].slice(0, 120);
}

/** Todas as etapas da versão, na ordem estável do documento BPMN. */
export function demandStageSnapshots(version: PublishedProcessVersion): DemandStageSnapshot[] {
  return [...version.graph.nodes.values()]
    .filter((node) => node.role !== "start")
    .map((node, index) => {
      const config = version.steps.get(node.id) ?? null;
      return {
        bpmnElementId: node.id,
        title: cleanText(config?.name || node.name, 160) || (node.role === "end" ? "Fim" : node.id),
        position: (index + 1) * 1000,
        processStepConfigId: config?.id || null,
        responsibleAreaId: config?.responsibleDepartmentId || config?.departmentId || null,
        responsibleUserId: config?.responsibleUserId || null,
        config,
      };
    });
}

/** Materializa a fotografia completa das etapas na criação da demanda. */
export function prepareStageInserts(d1: Database, input: {
  workspaceId: string;
  cardId: string;
  version: PublishedProcessVersion;
  initialStepId: string;
  initialDueAt: string | null;
}) {
  return demandStageSnapshots(input.version).map((stage) => {
    const active = stage.bpmnElementId === input.initialStepId;
    return d1.prepare(`INSERT INTO fdp_demand_stages
      (id, workspace_id, card_id, process_version_id, process_step_config_id,
       bpmn_element_id, title, status, position, responsible_area_id,
       responsible_user_id, due_at, snapshot_json, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        crypto.randomUUID(), input.workspaceId, input.cardId, input.version.versionId,
        stage.processStepConfigId, stage.bpmnElementId, stage.title,
        active ? "in_progress" : "pending", stage.position,
        stage.responsibleAreaId, stage.responsibleUserId,
        active ? input.initialDueAt : null,
        JSON.stringify(stage.config ?? {}), active ? new Date().toISOString() : null,
      );
  });
}

/** Fecha a etapa atual e abre a próxima junto com a transição da demanda. */
export function prepareStageTransitionStatements(d1: Database, input: {
  workspaceId: string;
  cardId: string;
  fromStepId: string;
  toStepId: string;
  dueAt: string | null;
  terminal: boolean;
}) {
  return [
    d1.prepare(`UPDATE fdp_demand_stages
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND card_id = ? AND bpmn_element_id = ?`)
      .bind(input.workspaceId, input.cardId, input.fromStepId),
    d1.prepare(`UPDATE fdp_demand_stages
      SET status = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
          due_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND card_id = ? AND bpmn_element_id = ?`)
      .bind(input.terminal ? "completed" : "in_progress", input.terminal,
        input.dueAt, input.workspaceId, input.cardId, input.toStepId),
  ];
}

/** Ativa as tarefas já materializadas quando a demanda entra na etapa. */
export function prepareTaskActivationStatements(d1: Database, input: {
  workspaceId: string;
  cardId: string;
  stepId: string;
  tasks: readonly TaskTemplate[];
  stepDueAt: string | null;
}) {
  const startedAt = new Date().toISOString();
  return input.tasks.map((task) => d1.prepare(`UPDATE fdp_checklist_items
      SET started_at = COALESCE(started_at, ?), due_at = COALESCE(due_at, ?)
      WHERE workspace_id = ? AND card_id = ? AND process_step_id = ? AND template_key = ?`)
    .bind(startedAt, taskDeadline(task, input.stepDueAt),
      input.workspaceId, input.cardId, input.stepId, task.key));
}

/**
 * Statements que materializam as tarefas de uma etapa numa demanda.
 *
 * Um único lugar constrói a linha da tarefa, e os três caminhos que instanciam
 * etapa — criação da demanda, avanço manual e resolução de proposta de agente —
 * chamam este. Antes cada um montava seu próprio `INSERT` com sete colunas; com
 * dezenove, três cópias divergiriam na primeira alteração.
 */
export function prepareTaskInserts(d1: Database, input: {
  workspaceId: string;
  cardId: string;
  stepId: string;
  tasks: readonly TaskTemplate[];
  /** Prazo da etapa, herdado pela tarefa que não tem SLA próprio. */
  stepDueAt: string | null;
  /** Área responsável da etapa, herdada pela tarefa que não nomeia a sua. */
  fallbackAreaId?: string | null;
  /** Etapas futuras já existem, mas suas tarefas ainda não começaram. */
  active?: boolean;
}) {
  const startedAt = input.active === false ? null : new Date().toISOString();
  return input.tasks.map((task) => d1.prepare(
    `INSERT INTO fdp_checklist_items
       (id, workspace_id, card_id, title, description, instructions, completed, position,
        process_step_id, template_key, area_id, assignee_user_id, assignee_role,
        sla_value, sla_unit, started_at, due_at, required, blocks_advance,
        evidence_required, document_required, completion_rule, depends_on_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.workspaceId, input.cardId,
    task.name, task.description, task.instructions,
    task.position, input.stepId, task.key,
    task.areaId || input.fallbackAreaId || null,
    task.assigneeUserId || null, task.assigneeRole,
    task.slaValue, task.slaUnit,
    startedAt, input.active === false ? null : taskDeadline(task, input.stepDueAt),
    task.required ? 1 : 0, task.blocksAdvance ? 1 : 0,
    task.evidenceRequired ? 1 : 0, task.documentRequired, task.completionRule,
    JSON.stringify(task.dependsOn),
  ));
}

/* -------------------------------------------------------------------------- *
 * Transição
 * -------------------------------------------------------------------------- */

export type ProcessInstanceRow = {
  id: string;
  workspaceId: string;
  boardId: string;
  companyId: string | null;
  archived: boolean;
  createdBy: string;
  processDefinitionId: string;
  processVersionId: string;
  processVersionNumber: string;
  currentStepId: string;
  version: number;
  /**
   * Fatos da demanda para as condições de transição (§25).
   *
   * Montados aqui, junto do resto da instância, para que nenhuma rota precise
   * lembrar de passá-los: uma condição que não é avaliada porque um chamador
   * esqueceu um argumento é pior que condição nenhuma — ela libera a passagem
   * em silêncio.
   */
  facts: ConditionFacts;
  /**
   * Canais de integração em erro no workspace, em minúsculas (§25).
   *
   * Vem junto pelo mesmo motivo dos fatos: uma regra que depende de um
   * argumento que o chamador pode esquecer é uma regra que às vezes não vale.
   */
  failingIntegrations: ReadonlySet<string>;
  /**
   * Nome dos arquivos anexados à demanda (§26).
   *
   * Carregado aqui pelo mesmo motivo dos fatos e das integrações: a conferência
   * por documento não pode depender de a rota lembrar de passar a lista — uma
   * exigência que às vezes não é medida é pior do que exigência nenhuma, porque
   * quem configurou acredita que ela vale.
   */
  attachmentNames: readonly string[];
};

export async function loadProcessInstance(d1: Database, workspaceId: string, cardId: string): Promise<ProcessInstanceRow> {
  const row = await d1.prepare(`SELECT id, workspace_id, board_id, company_id, archived, created_by,
      process_definition_id, process_version_id, process_version_number, current_step_id, version,
      priority, company, competence, process_type, requester_area_id, responsible_area_id, sla_status
    FROM fdp_cards WHERE workspace_id = ? AND id = ?`).bind(workspaceId, cardId).first<Row>();
  if (!row) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
  if (!text(row.process_version_id)) {
    // Demanda legada não é defeito; ela apenas não tem etapa para avançar.
    throw ApiError.badRequest(
      "Esta demanda não foi criada a partir de uma versão de processo, então não possui etapas para avançar.",
      "CARD_WITHOUT_PROCESS",
    );
  }
  /* Os valores personalizados da demanda, para as condições poderem falar
     sobre eles. Uma consulta a mais só quando a demanda tem processo — que é
     exatamente quando alguém pode querer avançar de etapa. */
  /* Integrações com erro agora. Uma consulta pequena e indexada por workspace,
     no mesmo lote lógico dos fatos — e só para demanda com processo, que é
     quando alguém pode querer avançar. */
  const failing = await d1.prepare(
    `SELECT channel FROM fdp_integrations WHERE workspace_id = ? AND status = 'error'`,
  ).bind(workspaceId).all<Row>();

  const customValues = await d1.prepare(
    `SELECT cf.field_key, v.value_text
       FROM fdp_custom_field_values v
       JOIN fdp_custom_fields cf ON cf.workspace_id = v.workspace_id AND cf.id = v.field_id
      WHERE v.workspace_id = ? AND v.card_id = ?`,
  ).bind(workspaceId, cardId).all<Row>();

  /* O nome dos anexos, para a conferência por documento (§26, §43).
     O recorte é a etapa atual **mais** os anexos sem etapa. Os dois lados
     importam: com só a etapa, toda demanda aberta antes da migration 0072
     perderia as provas que já tinha — todo anexo existente tem `process_step_id`
     vazio (§48). Sem o recorte, um comprovante enviado na etapa de Registro
     continuaria satisfazendo a exigência escrita na etapa de Documentação, que
     é exatamente o furo que §43 aponta.

     O teto evita que uma demanda com centenas de arquivos transforme a leitura
     da etapa numa consulta cara. */
  const attachments = await d1.prepare(
    `SELECT filename FROM fdp_card_attachments
      WHERE workspace_id = ? AND card_id = ?
        AND (process_step_id = ? OR process_step_id = '')
      ORDER BY created_at DESC LIMIT 200`,
  ).bind(workspaceId, cardId, text(row.current_step_id)).all<Row>();

  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    boardId: text(row.board_id),
    companyId: text(row.company_id) || null,
    archived: flag(row.archived),
    createdBy: text(row.created_by),
    processDefinitionId: text(row.process_definition_id),
    processVersionId: text(row.process_version_id),
    processVersionNumber: text(row.process_version_number),
    currentStepId: text(row.current_step_id),
    version: Number(row.version ?? 1),
    facts: {
      priority: text(row.priority),
      company: text(row.company),
      companyId: text(row.company_id),
      competence: text(row.competence),
      processType: text(row.process_type),
      requesterAreaId: text(row.requester_area_id),
      responsibleAreaId: text(row.responsible_area_id),
      slaStatus: text(row.sla_status),
      /* Campos personalizados entram com prefixo para não colidirem com os
         fatos da própria demanda: um campo chamado "empresa" não pode
         sequestrar a condição escrita sobre a empresa do cadastro. */
      ...Object.fromEntries(customValues.results.map((item) => [
        `custom:${text(item.field_key)}`,
        text(item.value_text),
      ])),
    },
    failingIntegrations: new Set(failing.results.map((row2) => text(row2.channel).toLowerCase())),
    attachmentNames: attachments.results.map((row2) => text(row2.filename)).filter(Boolean),
  };
}

export type TransitionActor = {
  userId: string;
  email: string;
  role: string;
  /** Capacidades já resolvidas pela autorização; o motor não recalcula papel. */
  canDecideApprovals: boolean;
  /** Áreas às quais a pessoa pertence, para os modos de responsabilidade por departamento. */
  areaIds: ReadonlySet<string>;
};

export type TransitionRequirement = {
  code: string;
  message: string;
};

export type TransitionEvaluation = {
  allowed: boolean;
  blockers: TransitionRequirement[];
  targetStepId: string;
  targetLabel: string;
  terminal: boolean;
};

/**
 * Requisitos da etapa **de saída**.
 *
 * A pergunta é "esta etapa está concluída?", não "a próxima está pronta": o que
 * trava a passagem é o que ficou por fazer aqui. Cada bloqueio tem código
 * próprio porque a tela precisa dizer o que resolve, e "não foi possível
 * concluir a operação" é justamente o que este produto já aprendeu a não fazer.
 */
export function evaluateStepRequirements(input: {
  config: ProcessStepConfig | null;
  actor: TransitionActor;
  createdByEmail: string;
  pendingChecklist: number;
  attachmentCount: number;
  /** Nome dos arquivos anexados à demanda, para a conferência por documento (§26). */
  attachmentNames: readonly string[];
  /**
   * As tarefas que estão travando, quando quem chama sabe quais são (§42).
   *
   * Opcional: `pendingChecklist` sozinho continua valendo e produz a mesma
   * recusa de antes. Quando os títulos vêm junto, a mensagem diz *o que* fazer
   * em vez de quantos itens faltam — "esta etapa tem 3 itens em aberto" obriga
   * a pessoa a ir procurar quais.
   */
  blockingTasks?: readonly { title: string }[];
}): TransitionRequirement[] {
  const blockers: TransitionRequirement[] = [];
  const { config, actor } = input;
  if (!config) return blockers;

  const named = input.blockingTasks ?? [];
  const pending = named.length || input.pendingChecklist;
  if (pending > 0) {
    blockers.push({
      code: "PROCESS_STEP_CHECKLIST_PENDING",
      message: named.length
        ? (named.length === 1
          ? `A tarefa «${named[0].title}» precisa ser concluída antes de avançar.`
          : `${named.length} tarefas obrigatórias desta etapa continuam em aberto: ${named.slice(0, 4).map((task) => `«${task.title}»`).join(", ")}${named.length > 4 ? " e outras" : ""}.`)
        : `Esta etapa tem ${pending} item(ns) de checklist em aberto.`,
    });
  }
  if (config.evidenceRequired && input.attachmentCount === 0) {
    blockers.push({
      code: "PROCESS_STEP_EVIDENCE_REQUIRED",
      message: "Esta etapa exige evidência anexada antes de avançar.",
    });
  }

  /* Conferência por documento (§26).
     `evidenceRequired` pergunta "existe algum anexo"; esta pergunta "existe o
     anexo *deste* documento". São exigências diferentes e podem coexistir: a
     primeira cobre a etapa que quer prova de qualquer natureza, a segunda a
     etapa que sabe exatamente o que precisa receber.

     Só vale quando a etapa pediu — `declared` é o padrão, e é o comportamento
     que as versões já publicadas continuam tendo (§48). */
  if (config.documentProof === "attached" && config.requiredDocuments.length) {
    const missing = missingDocuments(config.requiredDocuments, input.attachmentNames);
    if (missing.length) {
      blockers.push({
        code: "PROCESS_STEP_DOCUMENT_MISSING",
        message: describeMissingDocuments(missing),
      });
    }
  }

  if (config.responsibilityMode === "USER" && config.responsibleUserId
    && config.responsibleUserId !== actor.userId && actor.role !== "admin") {
    blockers.push({
      code: "PROCESS_STEP_NOT_RESPONSIBLE",
      message: "Esta etapa está atribuída a outra pessoa.",
    });
  }
  if (config.responsibilityMode === "DEPARTMENT" && config.departmentId
    && !actor.areaIds.has(config.departmentId) && actor.role !== "admin") {
    blockers.push({
      code: "PROCESS_STEP_NOT_IN_DEPARTMENT",
      message: "Esta etapa pertence a outro departamento.",
    });
  }

  if (config.requiresApproval) {
    const namedApprover = Boolean(config.approverUserId);
    const isNamedApprover = namedApprover && config.approverUserId === actor.userId;
    const inApproverDepartment = Boolean(config.approverDepartmentId) && actor.areaIds.has(config.approverDepartmentId);
    if (!isNamedApprover && !inApproverDepartment && !actor.canDecideApprovals) {
      blockers.push({
        code: "PROCESS_STEP_APPROVAL_REQUIRED",
        message: "Esta etapa exige aprovação e você não é aprovador dela.",
      });
    } else if (!isNamedApprover && input.createdByEmail && input.createdByEmail === actor.email) {
      // Autoaprovação: o produto já bloqueia nas movimentações e o processo não
      // pode ser a porta dos fundos disso.
      blockers.push({
        code: "PROCESS_STEP_SELF_APPROVAL",
        message: "Quem abriu a demanda não pode aprovar a própria etapa.",
      });
    }
  }
  return blockers;
}

/**
 * Decide se a transição pode acontecer, e por quê não quando não pode.
 *
 * Separada da escrita de propósito: a tela chama isto para desenhar os botões
 * de avanço com o motivo do bloqueio no título, e a rota chama de novo antes de
 * gravar. Avaliar duas vezes é barato; confiar no que a tela decidiu, não.
 */
export function evaluateTransition(input: {
  version: PublishedProcessVersion;
  instance: ProcessInstanceRow;
  targetStepId: string;
  actor: TransitionActor;
  pendingChecklist: number;
  attachmentCount: number;
  /**
   * Fatos da demanda para as condições de transição (§25).
   *
   * Opcional: processo sem condição configurada não precisa deles, e omiti-los
   * mantém o comportamento anterior intacto — que é o contrato desta adição.
   */
  facts?: ConditionFacts;
  /** Canais de integração em erro agora. Omitido, usa o que a instância trouxe. */
  failingIntegrations?: ReadonlySet<string>;
  /** Nome dos anexos. Omitido, usa o que a instância trouxe (§26). */
  attachmentNames?: readonly string[];
  /** Tarefas obrigatórias e bloqueantes ainda em aberto nesta etapa (§42). */
  blockingTasks?: readonly { title: string }[];
}): TransitionEvaluation {
  const { version, instance, actor } = input;
  const targetStepId = cleanText(input.targetStepId, 160);
  const blockers: TransitionRequirement[] = [];

  if (instance.processVersionId !== version.versionId) {
    blockers.push({
      code: "PROCESS_VERSION_MISMATCH",
      message: "Esta demanda segue outra versão do processo.",
    });
  }
  if (instance.archived) {
    blockers.push({ code: "CARD_ARCHIVED", message: "Demanda arquivada não avança de etapa." });
  }
  if (!version.graph.nodes.has(instance.currentStepId)) {
    blockers.push({
      code: "PROCESS_STEP_UNKNOWN",
      message: "A etapa atual não existe no diagrama desta versão.",
    });
  }
  const permitted = allowedTargets(version.graph, instance.currentStepId);
  if (!targetStepId) {
    blockers.push({ code: "PROCESS_TARGET_REQUIRED", message: "Informe a etapa de destino." });
  } else if (!permitted.includes(targetStepId)) {
    blockers.push({
      code: "PROCESS_TRANSITION_NOT_ALLOWED",
      message: `O desenho do processo não liga "${stepLabel(version.graph, instance.currentStepId)}" a esta etapa.`,
    });
  }

  const currentConfig = version.steps.get(instance.currentStepId) ?? null;
  const facts = input.facts ?? instance.facts;

  /* Regra de saída da etapa atual e regra de entrada da etapa de destino (§23).
     São a mesma máquina das condições de seta, apontada para outro lugar: a de
     saída pergunta "esta etapa já pode ser deixada", a de entrada pergunta
     "aquela etapa já pode receber". Separá-las importa porque o motivo é
     diferente, e uma pessoa barrada precisa saber qual das duas a barrou. */
  for (const unmet of unmetConditions(currentConfig?.exitRules, facts)) {
    blockers.push({
      code: "PROCESS_STEP_EXIT_RULE_UNMET",
      message: `Esta etapa só é concluída quando: ${describeCondition(unmet)}.`,
    });
  }
  if (targetStepId) {
    const targetConfig = version.steps.get(targetStepId) ?? null;
    for (const unmet of unmetConditions(targetConfig?.entryRules, facts)) {
      blockers.push({
        code: "PROCESS_STEP_ENTRY_RULE_UNMET",
        message: `A etapa "${stepLabel(version.graph, targetStepId)}" só recebe a demanda quando: ${describeCondition(unmet)}.`,
      });
    }
  }

  /* Integração quebrada trava a etapa que depende dela (§25).
     Uma etapa que espera o ERP não pode ser dada por concluída enquanto a
     sincronização está caída: o trabalho não chegou do outro lado, e concluir
     cria divergência que só aparece na conferência — quando já custou caro. */
  const failing = input.failingIntegrations ?? instance.failingIntegrations;
  for (const channel of currentConfig?.blockingIntegrations ?? []) {
    if (!failing.has(channel)) continue;
    blockers.push({
      code: "PROCESS_STEP_INTEGRATION_FAILING",
      message: `A integração ${channel} está com erro, e esta etapa depende dela para concluir.`,
    });
  }

  blockers.push(...evaluateStepRequirements({
    config: currentConfig,
    actor,
    createdByEmail: instance.createdBy,
    pendingChecklist: input.pendingChecklist,
    attachmentCount: input.attachmentCount,
    attachmentNames: input.attachmentNames ?? instance.attachmentNames,
    blockingTasks: input.blockingTasks,
  }));

  /* Condição da seta (§25).
     Duas setas podem ligar as mesmas duas etapas com condições diferentes — é
     assim que um desvio se escreve em BPMN. Por isso a pergunta é "existe
     alguma seta até este destino cuja condição bate", e não "a condição do
     destino bate": basta um caminho aberto para a transição ser legítima.

     Quando nenhuma bate, o bloqueio cita a condição do caminho que menos
     faltou. Listar as condições de todas as setas transformaria o motivo numa
     parede de texto sobre caminhos que a pessoa nem tentou seguir. */
  if (targetStepId && currentConfig && Object.keys(currentConfig.transitions).length > 0) {
    const paths = outgoingFlows(version.graph, instance.currentStepId)
      .filter((flow) => flow.target === targetStepId)
      .map((flow) => unmetConditions(currentConfig.transitions[flow.id], facts));

    if (paths.length > 0 && paths.every((unmet) => unmet.length > 0)) {
      const closest = paths.reduce((best, unmet) => (unmet.length < best.length ? unmet : best));
      blockers.push({
        code: "PROCESS_TRANSITION_CONDITION_UNMET",
        message: `Esta etapa só segue por aqui quando: ${closest.map(describeCondition).join("; ")}.`,
      });
    }
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    targetStepId,
    targetLabel: targetStepId ? stepLabel(version.graph, targetStepId) : "",
    terminal: targetStepId ? isTerminalStep(version.graph, targetStepId) : false,
  };
}

/** Destinos oferecidos à tela, já com o motivo de cada bloqueio (§15). */
export function availableTransitions(input: {
  version: PublishedProcessVersion;
  instance: ProcessInstanceRow;
  actor: TransitionActor;
  pendingChecklist: number;
  attachmentCount: number;
  facts?: ConditionFacts;
  failingIntegrations?: ReadonlySet<string>;
  attachmentNames?: readonly string[];
  blockingTasks?: readonly { title: string }[];
}) {
  return outgoingFlows(input.version.graph, input.instance.currentStepId).map((flow) => {
    const evaluation = evaluateTransition({ ...input, targetStepId: flow.target });
    return {
      flowId: flow.id,
      flowName: flow.name,
      // Contrato explícito do painel; os aliases antigos ficam para integrações.
      targetStepId: flow.target,
      targetLabel: evaluation.targetLabel,
      stepId: flow.target,
      stepLabel: evaluation.targetLabel,
      terminal: evaluation.terminal,
      allowed: evaluation.allowed,
      blockers: evaluation.blockers,
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Escrita
 * -------------------------------------------------------------------------- */

const SLA_MINUTES: Record<string, number> = { minutes: 1, hours: 60, days: 60 * 24 };

/**
 * Prazo da etapa a partir do que a versão configurou.
 *
 * Dia útil não é o mesmo que 24 horas para o DP, e o produto já tem o
 * calendário do workspace — usar o calendário quando a etapa pede dias úteis é
 * o que evita prometer entrega num feriado.
 */
export async function resolveStepDeadline(
  d1: Database, workspaceId: string, config: ProcessStepConfig | null, globalSlaMinutes: number,
): Promise<string | null> {
  const minutes = config && config.slaValue > 0
    ? config.slaValue * (SLA_MINUTES[config.slaUnit] ?? 60)
    : globalSlaMinutes;
  if (minutes <= 0) return null;

  if (config?.slaBusinessDays && config.slaUnit === "days") {
    const [settings, holidays] = await Promise.all([
      d1.prepare("SELECT business_days_json, day_end FROM fdp_workspace_settings WHERE workspace_id = ?")
        .bind(workspaceId).first<{ business_days_json: unknown; day_end: string }>(),
      d1.prepare("SELECT holiday_date FROM fdp_business_holidays WHERE workspace_id = ?")
        .bind(workspaceId).all<{ holiday_date: string }>(),
    ]);
    const businessDays = Array.isArray(settings?.business_days_json)
      ? (settings.business_days_json as number[])
      : (() => { try { return JSON.parse(text(settings?.business_days_json) || "[1,2,3,4,5]") as number[]; } catch { return [1, 2, 3, 4, 5]; } })();
    const holidaySet = new Set(holidays.results.map((row) => text(row.holiday_date)));
    const day = addBusinessDays(new Date().toISOString().slice(0, 10), config.slaValue, businessDays, holidaySet);
    return `${day}T${settings?.day_end || "18:00"}`;
  }
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export type StartInstanceInput = {
  workspaceId: string;
  version: PublishedProcessVersion;
  actor: { userId: string; email: string };
  boardId: string;
  listId: string;
  listSlaBehavior: string;
  title: string;
  description?: string;
  companyId?: string | null;
  companyName?: string;
  employeeId?: string | null;
  requesterUserId?: string | null;
  requesterAreaId?: string | null;
  responsibleAreaId?: string | null;
  competence?: string;
  priority?: string;
  sourceType?: string;
  globalSlaMinutes?: number;
  /** Origem e rastreabilidade do evento que provocou a instância (§5). */
  trigger?: string;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
  evidenceRefs?: readonly string[];
  requestId?: string | null;
};

export type StartedInstance = {
  cardId: string;
  stepId: string;
  stepLabel: string;
  versionNumber: string;
  dueAt: string | null;
  checklist: string[];
  stageCount: number;
  taskCount: number;
};

/**
 * Instancia uma versão publicada como demanda.
 *
 * Devolve os *statements*, e não o resultado, de propósito: quem chama executa
 * tudo em um único `batch`, e o evento de domínio entra na mesma transação da
 * demanda. É o que garante que não existe demanda sem evento nem evento sem
 * demanda — e, com a chave de idempotência, que a segunda entrega da mesma
 * ocorrência aborta a transação inteira em vez de abrir a segunda demanda (§8).
 */
export async function prepareProcessInstance(d1: Database, input: StartInstanceInput) {
  const { version } = input;
  const initial = resolveInitialStep(version);
  const stages = demandStageSnapshots(version);
  const tasks = stepTasks(initial.config);
  const checklist = tasks.map((task) => task.name);
  const dueAt = await resolveStepDeadline(d1, input.workspaceId, initial.config, input.globalSlaMinutes ?? 0);
  const cardId = crypto.randomUUID();
  const priority = ["low", "normal", "high", "urgent"].includes(String(input.priority))
    ? String(input.priority)
    : initial.config?.demandPriority ?? version.defaultPriority;

  const position = await d1.prepare(
    "SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0",
  ).bind(input.listId).first<{ max_position: number }>();

  const statements = [
    d1.prepare(`INSERT INTO fdp_cards
      (id, workspace_id, board_id, list_id, title, description, company_id, company, employee_id, requester_user_id, process_type, priority,
       assignee_name, due_at, sla_status, position, source_type, created_by, competence,
       requester_area_id, responsible_area_id,
       process_definition_id, process_version_id, process_version_number, current_step_id, instantiated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(
        cardId, input.workspaceId, input.boardId, input.listId,
        cleanText(input.title, 180) || `${version.definitionName} — ${initial.label}`,
        cleanText(input.description, 4000),
        input.companyId ?? null, cleanText(input.companyName, 160),
        input.employeeId ?? null, input.requesterUserId ?? input.actor.userId,
        // O tipo de processo da demanda passa a ser o código da definição: é o
        // vocabulário do processo publicado, e não mais uma string solta.
        cleanText(version.definitionCode, 40).toUpperCase() || "PROCESSO",
        priority,
        dueAt, computeInstanceSlaStatus(dueAt, input.listSlaBehavior),
        Number(position?.max_position ?? 0) + 1000,
        cleanText(input.sourceType, 40) || "process",
        input.actor.email,
        cleanText(input.competence, 7),
        input.requesterAreaId ?? initial.config?.requesterDepartmentId ?? null,
        input.responsibleAreaId ?? initial.config?.responsibleDepartmentId ?? initial.config?.departmentId ?? null,
        version.definitionId, version.versionId, version.versionNumber, initial.stepId,
      ),
    ...prepareStageInserts(d1, {
      workspaceId: input.workspaceId, cardId, version,
      initialStepId: initial.stepId, initialDueAt: dueAt,
    }),
    ...stages.flatMap((stage) => prepareTaskInserts(d1, {
      workspaceId: input.workspaceId, cardId,
      stepId: stage.bpmnElementId, tasks: stepTasks(stage.config),
      stepDueAt: stage.bpmnElementId === initial.stepId ? dueAt : null,
      fallbackAreaId: stage.responsibleAreaId,
      active: stage.bpmnElementId === initial.stepId,
    })),
  ];

  const result: StartedInstance = {
    cardId, stepId: initial.stepId, stepLabel: initial.label,
    versionNumber: version.versionNumber, dueAt, checklist,
    stageCount: stages.length,
    taskCount: stages.reduce((total, stage) => total + stepTasks(stage.config).length, 0),
  };
  return { statements, result };
}

/** `computeSlaStatus` sem importar a camada de API dentro do domínio. */
function computeInstanceSlaStatus(dueAt: string | null, behavior: string) {
  if (behavior === "paused") return "paused";
  if (behavior === "completed") return "completed";
  if (!dueAt) return "safe";
  const today = new Date().toISOString().slice(0, 10);
  const due = dueAt.slice(0, 10);
  if (due < today) return "overdue";
  if (due === today) return "warning";
  return "safe";
}

/**
 * Statement da transição.
 *
 * O `WHERE` carrega a etapa atual **e** a versão otimista lidas antes da
 * avaliação. Se qualquer uma tiver mudado no meio do caminho, nenhuma linha é
 * atualizada e quem chama devolve 409 — em vez de sobrescrever a decisão de
 * outra pessoa com uma avaliação feita sobre um estado que já não existe (§34).
 */
export function prepareTransitionStatement(d1: Database, input: {
  workspaceId: string; cardId: string; fromStepId: string; toStepId: string;
  expectedVersion: number; terminal: boolean; dueAt: string | null;
}) {
  /* A versão não é incrementada aqui: o trigger `fdp_cards_version_bump` faz
     isso em toda alteração da linha (migration 0061). Somar `version + 1` no
     `SET` também produziria um salto de dois, e — pior — deixaria a garantia
     dependente de cada caminho de escrita lembrar de somar. */
  return d1.prepare(`UPDATE fdp_cards
      SET current_step_id = ?, updated_at = CURRENT_TIMESTAMP,
          due_at = COALESCE(?, due_at),
          closed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE closed_at END
    WHERE workspace_id = ? AND id = ? AND current_step_id = ? AND version = ?
    RETURNING id, version`)
    .bind(
      input.toStepId, input.dueAt, input.terminal,
      input.workspaceId, input.cardId, input.fromStepId, input.expectedVersion,
    );
}
