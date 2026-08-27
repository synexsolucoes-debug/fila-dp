import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedTargets, initialStepId, isTerminalStep, outgoingFlows, parseBpmnGraph, stepLabel,
} from "../lib/bpmn-graph.ts";
import {
  evaluateStepRequirements, evaluateTransition, stepChecklist,
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
  transitions: {},
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

const instance = (overrides: Partial<ProcessInstanceRow> = {}): ProcessInstanceRow => ({
  id: "card-1", workspaceId: "w1", boardId: "b1", companyId: "c1", archived: false,
  createdBy: "solicitante@empresa.com",
  processDefinitionId: "def-1", processVersionId: "ver-4", processVersionNumber: "4.0",
  currentStepId: "Task_documentos", version: 3, facts: {}, ...overrides,
});

const clean = { pendingChecklist: 0, attachmentCount: 0 };

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
    createdByEmail: "outro@empresa.com", pendingChecklist: 0, attachmentCount: 0,
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), ["PROCESS_STEP_EVIDENCE_REQUIRED"]);
});

test("etapa atribuída a outra pessoa não é avançada por quem não é responsável", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ responsibilityMode: "USER", responsibleUserId: "user-2" }),
    actor: actor(), createdByEmail: "outro@empresa.com", pendingChecklist: 0, attachmentCount: 0,
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), ["PROCESS_STEP_NOT_RESPONSIBLE"]);
});

test("o administrador não fica preso à atribuição da etapa", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ responsibilityMode: "USER", responsibleUserId: "user-2" }),
    actor: actor({ role: "admin" }), createdByEmail: "outro@empresa.com",
    pendingChecklist: 0, attachmentCount: 0,
  });
  assert.deepEqual(blockers, []);
});

test("aprovação: quem não é aprovador não avança", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ requiresApproval: true, approverUserId: "gestor-1" }),
    actor: actor(), createdByEmail: "outro@empresa.com", pendingChecklist: 0, attachmentCount: 0,
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), ["PROCESS_STEP_APPROVAL_REQUIRED"]);
});

test("aprovação: quem abriu a demanda não aprova a própria etapa", () => {
  const blockers = evaluateStepRequirements({
    config: stepConfig({ requiresApproval: true, approverDepartmentId: "area-1" }),
    actor: actor({ areaIds: new Set(["area-1"]) }),
    createdByEmail: "analista@empresa.com", pendingChecklist: 0, attachmentCount: 0,
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), ["PROCESS_STEP_SELF_APPROVAL"]);
});

test("aprovador nomeado aprova mesmo tendo aberto a demanda", () => {
  // Nomear a pessoa é a decisão explícita de que ela é a aprovadora daquela
  // etapa; recusá-la aqui inventaria uma regra que ninguém configurou.
  const blockers = evaluateStepRequirements({
    config: stepConfig({ requiresApproval: true, approverUserId: "user-1" }),
    actor: actor(), createdByEmail: "analista@empresa.com", pendingChecklist: 0, attachmentCount: 0,
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
    config: null, actor: actor(), createdByEmail: "x@y.com", pendingChecklist: 5, attachmentCount: 0,
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
