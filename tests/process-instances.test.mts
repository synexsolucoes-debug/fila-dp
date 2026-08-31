import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allowedTargets, initialStepId, isTerminalStep, outgoingFlows, parseBpmnGraph, stepLabel,
} from "../lib/bpmn-graph.ts";
import {
  demandStageSnapshots, evaluateStepRequirements, evaluateTransition, loadProcessInstance, stepChecklist,
  type ProcessInstanceRow, type ProcessStepConfig, type PublishedProcessVersion, type TransitionActor,
} from "../lib/process-instances.ts";

/* O elo que faltava: uma versão publicada que gera trabalho e uma etapa que só
   anda quando o desenho e os requisitos deixam. Os testes abaixo cobrem as duas
   metades — ler o desenho, e recusar o que ele não autoriza. */

const ADMISSION_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="Process_admissao" name="Admissão">
    <bpmn:startEvent id="Start_1" name="Início"><bpmn:outgoing>Flow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:userTask id="Task_documentos" name="Conferir documentos"/>
    <bpmn:exclusiveGateway id="Gateway_1" name="Documentos ok?"/>
    <bpmn:userTask id="Task_registro" name="Registrar no ERP"/>
    <bpmn:userTask id="Task_pendencia" name="Solicitar pendência &gt; 2 dias"/>
    <bpmn:endEvent id="End_1" name="Fim"/>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_documentos"/>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_documentos" targetRef="Gateway_1"/>
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Gateway_1" targetRef="Task_registro" name="Sim"/>
    <bpmn:sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="Task_pendencia" name="Não"/>
    <bpmn:sequenceFlow id="Flow_5" sourceRef="Task_registro" targetRef="End_1"/>
    <bpmn:sequenceFlow id="Flow_6" sourceRef="Task_pendencia" targetRef="Task_documentos"/>
    <bpmn:sequenceFlow id="Flow_orfa" sourceRef="Task_registro" targetRef="Nao_existe"/>
  </bpmn:process>
</bpmn:definitions>`;

const graph = parseBpmnGraph(ADMISSION_BPMN);

test("o grafo lê os nós e as setas do BPMN publicado", () => {
  assert.equal(graph.processId, "Process_admissao");
  assert.equal(graph.nodes.size, 6);
  assert.deepEqual(graph.startIds, ["Start_1"]);
  assert.deepEqual(graph.endIds, ["End_1"]);
  assert.equal(stepLabel(graph, "Task_documentos"), "Conferir documentos");
});

test("nome com entidade XML é decodificado, e o `>` dentro do atributo não corta a tag", () => {
  assert.equal(stepLabel(graph, "Task_pendencia"), "Solicitar pendência > 2 dias");
  // A seta que sai dessa etapa precisa ter sobrevivido à varredura.
  assert.deepEqual(allowedTargets(graph, "Task_pendencia"), ["Task_documentos"]);
});

test("seta apontando para elemento inexistente é descartada", () => {
  assert.deepEqual(allowedTargets(graph, "Task_registro"), ["End_1"],
    "um destino pendurado viraria transição para lugar nenhum");
  assert.ok(!graph.flows.some((flow) => flow.id === "Flow_orfa"));
});

test("a etapa inicial é a primeira etapa de trabalho, não o evento de início", () => {
  assert.equal(initialStepId(graph), "Task_documentos");
});

test("o gateway oferece os dois destinos, com o rótulo da seta", () => {
  const flows = outgoingFlows(graph, "Gateway_1");
  assert.deepEqual(flows.map((flow) => flow.target), ["Task_registro", "Task_pendencia"]);
  assert.deepEqual(flows.map((flow) => flow.name), ["Sim", "Não"]);
});

test("o fim do processo é reconhecido", () => {
  assert.ok(isTerminalStep(graph, "End_1"));
  assert.ok(!isTerminalStep(graph, "Task_documentos"));
});

test("diagrama vazio não vira grafo silenciosamente", () => {
  const empty = parseBpmnGraph("<bpmn:definitions/>");
  assert.equal(empty.nodes.size, 0);
  assert.equal(initialStepId(empty), "");
});

/* -------------------------------------------------------------------------- */

const stepConfig = (overrides: Partial<ProcessStepConfig> = {}): ProcessStepConfig => ({
  id: "cfg", bpmnElementId: "Task_documentos", stepType: "USER_TASK", name: "Conferir documentos",
  instructions: "", departmentId: "", responsibleUserId: "", responsibilityMode: "DEPARTMENT",
  slaValue: 0, slaUnit: "hours", slaBusinessDays: false,
  requesterDepartmentId: "", responsibleDepartmentId: "",
  checklist: [], requiredDocuments: [], evidenceRequired: false,
  requiresApproval: false, approverUserId: "", approverDepartmentId: "", demandPriority: "normal",
  transitions: {}, entryRules: [], exitRules: [], blockingIntegrations: [],
  documentProof: "declared",
  tasks: [], automations: [],
  ...overrides,
});

const actor = (overrides: Partial<TransitionActor> = {}): TransitionActor => ({
  userId: "user-1", email: "analista@empresa.com", role: "member",
  canDecideApprovals: false, areaIds: new Set<string>(), ...overrides,
});

const version = (steps: Record<string, ProcessStepConfig> = {}): PublishedProcessVersion => ({
  definitionId: "def-1", definitionName: "Admissão", definitionCode: "ADM",
  isCorporate: true, defaultPriority: "normal",
  versionId: "ver-4", versionNumber: "4.0", bpmnXml: ADMISSION_BPMN, graph,
  steps: new Map(Object.entries(steps)),
});

test("a demanda materializa todas as etapas da versão na ordem do BPMN", () => {
  const snapshots = demandStageSnapshots(version({
    Task_documentos: stepConfig({
      id: "cfg-doc", responsibleDepartmentId: "area-dp", responsibleUserId: "user-dp",
    }),
  }));
  assert.deepEqual(snapshots.map((stage) => stage.bpmnElementId), [
    "Task_documentos", "Gateway_1", "Task_registro", "Task_pendencia", "End_1",
  ]);
  assert.equal(snapshots[0].title, "Conferir documentos");
  assert.equal(snapshots[0].processStepConfigId, "cfg-doc");
  assert.equal(snapshots[0].responsibleAreaId, "area-dp");
  assert.equal(snapshots.at(-1)?.title, "Fim");
});

test("instanciação cria etapas e tarefas futuras uma única vez", async () => {
  const motor = await readFile(new URL("../lib/process-instances.ts", import.meta.url), "utf8");
  assert.match(motor, /\.\.\.prepareStageInserts\(d1/u);
  assert.match(motor, /\.\.\.stages\.flatMap\(\(stage\) => prepareTaskInserts/u);
  assert.match(motor, /active: stage\.bpmnElementId === initial\.stepId/u);

  const rota = await readFile(new URL("../app/api/cards/[id]/process/route.ts", import.meta.url), "utf8");
  assert.match(rota, /prepareStageTransitionStatements/u);
  assert.match(rota, /prepareTaskActivationStatements/u);
  assert.doesNotMatch(rota, /\.\.\.prepareTaskInserts\(d1/u,
    "a transição ativa a tarefa já criada; não deve duplicá-la");
});

test("timeline persistida é isolada por workspace e aparece no detalhe", async () => {
  const migration = await readFile(
    new URL("../drizzle/postgres/0074_demand_stage_instances.sql", import.meta.url), "utf8");
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /fdp_demand_stages_workspace_isolation/u);
  assert.match(migration, /ON CONFLICT \("workspace_id", "card_id", "bpmn_element_id"\) DO NOTHING/u);

  const painel = await readFile(
    new URL("../app/painel/features/work/CardProcessPanel.tsx", import.meta.url), "utf8");
  assert.match(painel, /Etapas desta demanda/u);
  assert.match(painel, /aria-current=\{current \? "step" : undefined\}/u);
});

const instance = (overrides: Partial<ProcessInstanceRow> = {}): ProcessInstanceRow => ({
  id: "card-1", workspaceId: "w1", boardId: "b1", companyId: "c1", archived: false,
  createdBy: "solicitante@empresa.com",
  processDefinitionId: "def-1", processVersionId: "ver-4", processVersionNumber: "4.0",
  currentStepId: "Task_documentos", version: 3, facts: {},
  failingIntegrations: new Set<string>(), attachmentNames: [], ...overrides,
});

const clean = { pendingChecklist: 0, attachmentCount: 0, attachmentNames: [] as string[] };

test("transição que o desenho não liga é recusada", () => {
  const result = evaluateTransition({
    version: version(), instance: instance(), targetStepId: "End_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "PROCESS_TRANSITION_NOT_ALLOWED"));
});

test("transição que o desenho liga é aceita", () => {
  const result = evaluateTransition({
    version: version(), instance: instance(), targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, true, JSON.stringify(result.blockers));
  assert.equal(result.targetLabel, "Documentos ok?");
});

test("demanda de outra versão não avança por esta definição", () => {
  const result = evaluateTransition({
    version: version(), instance: instance({ processVersionId: "ver-3" }),
    targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.ok(result.blockers.some((blocker) => blocker.code === "PROCESS_VERSION_MISMATCH"),
    "publicar a v5 não pode arrastar quem segue a v4");
});

test("demanda arquivada não avança", () => {
  const result = evaluateTransition({
    version: version(), instance: instance({ archived: true }),
    targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.ok(result.blockers.some((blocker) => blocker.code === "CARD_ARCHIVED"));
});

test("checklist da etapa em aberto trava o avanço", () => {
  const result = evaluateTransition({
    version: version({ Task_documentos: stepConfig() }), instance: instance(),
    targetStepId: "Gateway_1", actor: actor(), pendingChecklist: 2, attachmentCount: 0,
  });
  assert.ok(result.blockers.some((blocker) => blocker.code === "PROCESS_STEP_CHECKLIST_PENDING"));
});

test("etapa que exige evidência recusa avanço sem anexo", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ evidenceRequired: true }), actor: actor(),
    createdByEmail: "outro@empresa.com", pendingChecklist: 0, attachmentCount: 0, attachmentNames: [],
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), ["PROCESS_STEP_EVIDENCE_REQUIRED"]);
});

test("etapa atribuída a outra pessoa não é avançada por quem não é responsável", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ responsibilityMode: "USER", responsibleUserId: "user-2" }),
    actor: actor(), createdByEmail: "outro@empresa.com", pendingChecklist: 0, attachmentCount: 0, attachmentNames: [],
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), ["PROCESS_STEP_NOT_RESPONSIBLE"]);
});

test("o administrador não fica preso à atribuição da etapa", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ responsibilityMode: "USER", responsibleUserId: "user-2" }),
    actor: actor({ role: "admin" }), createdByEmail: "outro@empresa.com",
    pendingChecklist: 0, attachmentCount: 0, attachmentNames: [],
  });
  assert.deepEqual(blockers, []);
});

test("aprovação: quem não é aprovador não avança", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ requiresApproval: true, approverUserId: "gestor-1" }),
    actor: actor(), createdByEmail: "outro@empresa.com", pendingChecklist: 0, attachmentCount: 0, attachmentNames: [],
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), ["PROCESS_STEP_APPROVAL_REQUIRED"]);
});

test("aprovação: quem abriu a demanda não aprova a própria etapa", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ requiresApproval: true, approverDepartmentId: "area-1" }),
    actor: actor({ areaIds: new Set(["area-1"]) }),
    createdByEmail: "analista@empresa.com", pendingChecklist: 0, attachmentCount: 0, attachmentNames: [],
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), ["PROCESS_STEP_SELF_APPROVAL"]);
});

test("aprovador nomeado aprova mesmo tendo aberto a demanda", () => {
  // Nomear a pessoa é a decisão explícita de que ela é a aprovadora daquela
  // etapa; recusá-la aqui inventaria uma regra que ninguém configurou.
  const blockers = evaluateStepRequirements({
    config: stepConfig({ requiresApproval: true, approverUserId: "user-1" }),
    actor: actor(), createdByEmail: "analista@empresa.com", pendingChecklist: 0, attachmentCount: 0, attachmentNames: [],
  });
  assert.deepEqual(blockers, []);
});

test("o checklist da etapa inclui um item por documento obrigatório", () => {
  const items = stepChecklist(stepConfig({
    checklist: ["Conferir CTPS"], requiredDocuments: ["Exame admissional", "Comprovante de endereço"],
  }));
  assert.deepEqual(items, [
    "Conferir CTPS",
    "Documento obrigatório: Exame admissional",
    "Documento obrigatório: Comprovante de endereço",
  ]);
});

test("etapa sem configuração não inventa requisito", () => {
  assert.deepEqual(stepChecklist(null), []);
  assert.deepEqual(evaluateStepRequirements({
    config: null, actor: actor(), createdByEmail: "x@y.com", pendingChecklist: 5, attachmentCount: 0, attachmentNames: [],
  }), []);
});

/* -------------------------------------------------------------------------- *
 * §25: condição de transição
 * -------------------------------------------------------------------------- */

/* O desenho de teste tem um gateway com duas saídas — `Flow_3` para o registro
   e `Flow_4` para a pendência. É exatamente a forma de um desvio: mesmo ponto
   de origem, dois caminhos, e um critério que decide qual vale. */

const gatewayVersion = (transitions: Record<string, unknown>) => version({
  Gateway_1: stepConfig({ id: "cfg-gw", bpmnElementId: "Gateway_1", stepType: "GATEWAY", name: "Documentos completos?", ...(transitions as object) }),
});

const atGateway = (facts: Record<string, string> = {}) =>
  instance({ currentStepId: "Gateway_1", facts });

test("seta sem condição continua incondicional", () => {
  // O contrato desta adição: processo que não usa condição não muda de
  // comportamento em nada.
  const evaluation = evaluateTransition({
    version: gatewayVersion({ transitions: {} }),
    instance: atGateway(),
    targetStepId: "Task_registro",
    actor: actor(),
    pendingChecklist: 0,
    attachmentCount: 0,
  });
  assert.equal(evaluation.allowed, true, evaluation.blockers.map((item) => item.message).join(" | "));
});

test("a condição da seta barra o caminho e diz qual é o critério", () => {
  const evaluation = evaluateTransition({
    version: gatewayVersion({
      transitions: { Flow_3: [{ field: "custom:documentos", operator: "equals", value: "completos" }] },
    }),
    instance: atGateway({ "custom:documentos": "pendentes" }),
    targetStepId: "Task_registro",
    actor: actor(),
    pendingChecklist: 0,
    attachmentCount: 0,
  });
  assert.equal(evaluation.allowed, false);
  const blocker = evaluation.blockers.find((item) => item.code === "PROCESS_TRANSITION_CONDITION_UNMET");
  assert.ok(blocker, "o bloqueio precisa ter código próprio");
  assert.match(blocker.message, /documentos é completos/u);
});

test("o outro caminho do mesmo gateway continua aberto", () => {
  // Um desvio que fechasse os dois lados prenderia a demanda no gateway.
  const evaluation = evaluateTransition({
    version: gatewayVersion({
      transitions: { Flow_3: [{ field: "custom:documentos", operator: "equals", value: "completos" }] },
    }),
    instance: atGateway({ "custom:documentos": "pendentes" }),
    targetStepId: "Task_pendencia",
    actor: actor(),
    pendingChecklist: 0,
    attachmentCount: 0,
  });
  assert.equal(evaluation.allowed, true, evaluation.blockers.map((item) => item.message).join(" | "));
});

test("condição satisfeita libera a passagem", () => {
  const evaluation = evaluateTransition({
    version: gatewayVersion({
      transitions: { Flow_3: [{ field: "custom:documentos", operator: "equals", value: "completos" }] },
    }),
    instance: atGateway({ "custom:documentos": "completos" }),
    targetStepId: "Task_registro",
    actor: actor(),
    pendingChecklist: 0,
    attachmentCount: 0,
  });
  assert.equal(evaluation.allowed, true, evaluation.blockers.map((item) => item.message).join(" | "));
});

test("os fatos vêm da própria demanda quando ninguém os passa", () => {
  // Uma condição que não é avaliada porque um chamador esqueceu um argumento
  // libera a passagem em silêncio — o pior modo de falhar que esta
  // funcionalidade poderia ter.
  const evaluation = evaluateTransition({
    version: gatewayVersion({
      transitions: { Flow_3: [{ field: "priority", operator: "equals", value: "urgent" }] },
    }),
    instance: atGateway({ priority: "normal" }),
    targetStepId: "Task_registro",
    actor: actor(),
    pendingChecklist: 0,
    attachmentCount: 0,
  });
  assert.equal(evaluation.allowed, false);
  assert.ok(evaluation.blockers.some((item) => item.code === "PROCESS_TRANSITION_CONDITION_UNMET"));
});

test("todas as condições da seta precisam bater, não apenas uma", () => {
  const evaluation = evaluateTransition({
    version: gatewayVersion({
      transitions: {
        Flow_3: [
          { field: "priority", operator: "equals", value: "urgent" },
          { field: "competence", operator: "is_not_empty", value: "" },
        ],
      },
    }),
    instance: atGateway({ priority: "urgent", competence: "" }),
    targetStepId: "Task_registro",
    actor: actor(),
    pendingChecklist: 0,
    attachmentCount: 0,
  });
  assert.equal(evaluation.allowed, false);
  const blocker = evaluation.blockers.find((item) => item.code === "PROCESS_TRANSITION_CONDITION_UNMET");
  assert.match(blocker!.message, /Competência está preenchido/u);
  // E cita só o que faltou, não o que já batia.
  assert.doesNotMatch(blocker!.message, /Prioridade/u);
});

test("a condição não substitui os requisitos da etapa, soma-se a eles", () => {
  // Checklist pendente e condição não atendida são dois motivos, e a pessoa
  // precisa saber dos dois — resolver um e continuar barrada sem explicação é
  // o que faz alguém achar que o sistema está travado.
  const evaluation = evaluateTransition({
    version: version({
      Gateway_1: stepConfig({
        id: "cfg-gw", bpmnElementId: "Gateway_1", stepType: "GATEWAY", name: "Documentos completos?",
        evidenceRequired: true,
        transitions: { Flow_3: [{ field: "priority", operator: "equals", value: "urgent" }] },
      }),
    }),
    instance: atGateway({ priority: "normal" }),
    targetStepId: "Task_registro",
    actor: actor(),
    pendingChecklist: 2,
    attachmentCount: 0,
  });
  assert.equal(evaluation.allowed, false);
  const codes = evaluation.blockers.map((item) => item.code).sort();
  assert.deepEqual(codes, [
    "PROCESS_STEP_CHECKLIST_PENDING",
    "PROCESS_STEP_EVIDENCE_REQUIRED",
    "PROCESS_TRANSITION_CONDITION_UNMET",
  ]);
});

/* -------------------------------------------------------------------------- *
 * §23: regra de entrada e de saída · §25: bloqueio por integração
 * -------------------------------------------------------------------------- */

const ruleVersion = (over: { exit?: unknown[]; entry?: unknown[]; integrations?: string[] } = {}) => version({
  Task_documentos: stepConfig({
    exitRules: (over.exit ?? []) as never,
    blockingIntegrations: over.integrations ?? [],
  }),
  Gateway_1: stepConfig({
    id: "cfg-gw", bpmnElementId: "Gateway_1", stepType: "GATEWAY", name: "Documentos ok?",
    entryRules: (over.entry ?? []) as never,
  }),
});

const rulesFor = (facts: Record<string, string>, failing: string[] = []) =>
  instance({ facts, failingIntegrations: new Set(failing) });

test("a regra de saída barra a conclusão da etapa atual, dizendo qual é", () => {
  const result = evaluateTransition({
    version: ruleVersion({ exit: [{ field: "competence", operator: "is_not_empty", value: "" }] }),
    instance: rulesFor({ competence: "" }),
    targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, false);
  const blocker = result.blockers.find((item) => item.code === "PROCESS_STEP_EXIT_RULE_UNMET");
  assert.ok(blocker);
  assert.match(blocker.message, /só é concluída quando: Competência está preenchido/u);
});

test("a regra de entrada barra a etapa de destino, e nomeia a etapa", () => {
  // Saída e entrada barram por motivos diferentes; quem foi barrado precisa
  // saber qual das duas o barrou, e onde.
  const result = evaluateTransition({
    version: ruleVersion({ entry: [{ field: "priority", operator: "equals", value: "urgent" }] }),
    instance: rulesFor({ priority: "normal" }),
    targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, false);
  const blocker = result.blockers.find((item) => item.code === "PROCESS_STEP_ENTRY_RULE_UNMET");
  assert.ok(blocker);
  assert.match(blocker.message, /A etapa "Documentos ok\?" só recebe a demanda quando: Prioridade é urgent/u);
});

test("regra satisfeita não aparece como bloqueio", () => {
  const result = evaluateTransition({
    version: ruleVersion({
      exit: [{ field: "competence", operator: "is_not_empty", value: "" }],
      entry: [{ field: "priority", operator: "equals", value: "urgent" }],
    }),
    instance: rulesFor({ competence: "2026-08", priority: "urgent" }),
    targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, true, result.blockers.map((item) => item.message).join(" | "));
});

test("integração em erro trava a etapa que declarou depender dela", () => {
  const result = evaluateTransition({
    version: ruleVersion({ integrations: ["sankhya"] }),
    instance: rulesFor({}, ["sankhya"]),
    targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, false);
  const blocker = result.blockers.find((item) => item.code === "PROCESS_STEP_INTEGRATION_FAILING");
  assert.ok(blocker);
  assert.match(blocker.message, /A integração sankhya está com erro/u);
});

test("integração em erro que a etapa não declarou não trava nada", () => {
  // Travar por uma integração que a etapa não usa transformaria uma falha do
  // Teams em parada do DP inteiro.
  const result = evaluateTransition({
    version: ruleVersion({ integrations: ["sankhya"] }),
    instance: rulesFor({}, ["teams"]),
    targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, true, result.blockers.map((item) => item.message).join(" | "));
});

test("etapa sem regra nenhuma continua com o comportamento de antes", () => {
  const result = evaluateTransition({
    version: ruleVersion(), instance: rulesFor({}), targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, true, result.blockers.map((item) => item.message).join(" | "));
});

test("as três regras somam-se aos requisitos, cada uma com seu código", () => {
  // Resolver uma e continuar barrado sem saber por quê é o que faz alguém achar
  // que o sistema travou.
  const result = evaluateTransition({
    version: version({
      Task_documentos: stepConfig({
        evidenceRequired: true,
        exitRules: [{ field: "competence", operator: "is_not_empty", value: "" }],
        blockingIntegrations: ["sankhya"],
      }),
      Gateway_1: stepConfig({
        id: "cfg-gw", bpmnElementId: "Gateway_1", stepType: "GATEWAY", name: "Documentos ok?",
        entryRules: [{ field: "priority", operator: "equals", value: "urgent" }],
      }),
    }),
    instance: rulesFor({ competence: "", priority: "normal" }, ["sankhya"]),
    targetStepId: "Gateway_1", actor: actor(), pendingChecklist: 1, attachmentCount: 0,
  });
  assert.deepEqual(result.blockers.map((item) => item.code).sort(), [
    "PROCESS_STEP_CHECKLIST_PENDING",
    "PROCESS_STEP_ENTRY_RULE_UNMET",
    "PROCESS_STEP_EVIDENCE_REQUIRED",
    "PROCESS_STEP_EXIT_RULE_UNMET",
    "PROCESS_STEP_INTEGRATION_FAILING",
  ]);
});

/* -------------------------------------------------------------------------- *
 * §48 e §108: demanda anterior à estrutura de processo
 * -------------------------------------------------------------------------- */

/* Um `d1` de mentira, pequeno o bastante para o teste e fiel ao contrato que
   `loadProcessInstance` usa: `prepare().bind().first()` e `.all()`. Ele existe
   para que a retrocompatibilidade seja verificada por comportamento, e não por
   leitura do código — que é o que a §108 pede. */
const fakeD1 = (card: Record<string, unknown> | null) => ({
  prepare: (query: string) => ({
    bind: () => ({
      first: async () => (query.includes("FROM fdp_cards") ? card : null),
      all: async () => ({ results: [] as Record<string, unknown>[] }),
    }),
  }),
});

const legacyCard = (over: Record<string, unknown> = {}) => ({
  id: "card-legado", workspace_id: "w1", board_id: "b1", company_id: null,
  archived: 0, created_by: "antigo@empresa.com",
  process_definition_id: null, process_version_id: null, process_version_number: "",
  current_step_id: "", version: 1,
  priority: "normal", company: "", competence: "", process_type: "OUTROS",
  requester_area_id: null, responsible_area_id: null, sla_status: "safe",
  ...over,
});

test("demanda sem versão de processo recusa com motivo, não com erro genérico", async () => {
  // Converter histórico automaticamente inventaria vínculo, e vínculo inventado
  // em DP vira erro trabalhista. Ela apenas não tem etapa para avançar — e o
  // produto precisa dizer isso, não estourar.
  await assert.rejects(
    () => loadProcessInstance(fakeD1(legacyCard()) as never, "w1", "card-legado"),
    (error: { code?: string; message?: string }) => {
      assert.equal(error.code, "CARD_WITHOUT_PROCESS");
      assert.match(String(error.message), /não foi criada a partir de uma versão de processo/u);
      return true;
    },
  );
});

test("demanda com versão mas sem área carrega normalmente", async () => {
  // A §47 acrescentou área solicitante e responsável. A demanda anterior a ela
  // não tem nenhuma das duas, e isso não pode impedi-la de andar.
  const instancia = await loadProcessInstance(
    fakeD1(legacyCard({
      process_definition_id: "def-1", process_version_id: "ver-4",
      process_version_number: "4.0", current_step_id: "Task_documentos",
    })) as never,
    "w1", "card-legado",
  );
  assert.equal(instancia.processVersionId, "ver-4");
  assert.equal(instancia.companyId, null);
  assert.equal(instancia.facts.requesterAreaId, "");
  assert.equal(instancia.facts.responsibleAreaId, "");
  // Sem campo personalizado e sem integração em erro: os dois recortes novos
  // nascem vazios em vez de indefinidos, para nenhuma regra tropeçar neles.
  assert.equal(instancia.failingIntegrations.size, 0);
});

test("condição sobre área numa demanda que não tem área falha, e não passa", () => {
  // O fato existe e está vazio. Uma regra que exigisse área precisa barrar,
  // não liberar — senão a demanda antiga viraria o caminho fácil.
  const result = evaluateTransition({
    version: ruleVersion({ exit: [{ field: "responsibleAreaId", operator: "is_not_empty", value: "" }] }),
    instance: rulesFor({ responsibleAreaId: "" }),
    targetStepId: "Gateway_1", actor: actor(), ...clean,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.blockers.some((item) => item.code === "PROCESS_STEP_EXIT_RULE_UNMET"));
});

test("demanda inexistente continua sendo 404, não 500", async () => {
  await assert.rejects(
    () => loadProcessInstance(fakeD1(null) as never, "w1", "nao-existe"),
    (error: { code?: string }) => {
      assert.equal(error.code, "CARD_NOT_FOUND");
      return true;
    },
  );
});

test("etapa que exige aval diz isso na tela, antes do clique", async () => {
  /* A definição do usuário: "aprovar é liberar o avanço de etapa que exige
     aval". O motor já fazia exatamente isso — `requiresApproval`,
     `approverUserId`, `approverDepartmentId`, o bloqueio
     PROCESS_STEP_APPROVAL_REQUIRED e a recusa de autoaprovação existiam desde
     antes. O que faltava era a tela DIZER: o botão chamava de "Avançar" um ato
     que tem responsável e consequência, e nada avisava que o clique era um aval.

     Construir um sistema de aprovação novo teria criado um segundo, concorrendo
     com o que já decide. */
  const rota = await readFile(
    new URL("../app/api/cards/[id]/process/route.ts", import.meta.url), "utf8");
  assert.match(rota, /requiresApproval: Boolean\(version\.steps\.get\(instance\.currentStepId\)\?\.requiresApproval\)/u,
    "vem da configuração já carregada — sem consulta nova");

  const painel = await readFile(
    new URL("../app/painel/features/work/CardProcessPanel.tsx", import.meta.url), "utf8");
  assert.match(painel, /instance\.requiresApproval \? "Aprovar e avançar" : "Avançar"/u,
    "quando a etapa exige aval, avançar É aprovar, e o botão precisa dizer");
  assert.match(painel, /Esta etapa exige aprovação/u,
    "o aviso vem antes da lista: quem chega precisa saber que o clique é um aval");
});

test("a recusa de autoaprovação continua sendo do motor, não da tela", async () => {
  /* A tela avisa; quem recusa é o servidor. Mover essa decisão para o cliente
     abriria o caminho lateral que o guard existe para fechar. */
  const motor = await readFile(new URL("../lib/process-instances.ts", import.meta.url), "utf8");
  assert.match(motor, /PROCESS_STEP_SELF_APPROVAL/u);
  assert.match(motor, /Quem abriu a demanda não pode aprovar a própria etapa\./u);
  assert.match(motor, /PROCESS_STEP_APPROVAL_REQUIRED/u);
});
