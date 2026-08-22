import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseBpmnGraph } from "../lib/bpmn-graph.ts";
import { durationLabel, orderedSteps, summarizeSteps } from "../lib/process-usage.ts";
import type { ProcessStepConfig, PublishedProcessVersion } from "../lib/process-instances.ts";

/* A leitura textual do processo existe para que ninguém precise interpretar um
   BPMN para trabalhar (§43). Estes testes protegem o que a torna confiável: a
   ordem certa, nenhuma etapa escondida, e a exigência de cada uma dita por
   extenso. */

const XML = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P1">
    <startEvent id="Start" name="Início"><outgoing>F0</outgoing></startEvent>
    <userTask id="Conferencia" name="Conferência cadastral"><incoming>F0</incoming><outgoing>F1</outgoing></userTask>
    <userTask id="Aprovacao" name="Aprovação > 2 dias"><incoming>F1</incoming><outgoing>F2</outgoing></userTask>
    <endEvent id="Fim" name="Concluído"><incoming>F2</incoming></endEvent>
    <userTask id="Orfa" name="Etapa sem entrada" />
    <sequenceFlow id="F0" sourceRef="Start" targetRef="Conferencia" />
    <sequenceFlow id="F1" sourceRef="Conferencia" targetRef="Aprovacao" />
    <sequenceFlow id="F2" sourceRef="Aprovacao" targetRef="Fim" />
  </process>
</definitions>`;

const step = (overrides: Partial<ProcessStepConfig>): ProcessStepConfig => ({
  id: "", bpmnElementId: "", stepType: "TASK", name: "", instructions: "",
  departmentId: "", responsibleUserId: "", responsibilityMode: "ANY",
  slaValue: 0, slaUnit: "hours", slaBusinessDays: false,
  requesterDepartmentId: "", responsibleDepartmentId: "",
  checklist: [], requiredDocuments: [], evidenceRequired: false,
  requiresApproval: false, approverUserId: "", approverDepartmentId: "",
  demandPriority: "normal", ...overrides,
});

const graph = parseBpmnGraph(XML);

const version: PublishedProcessVersion = {
  definitionId: "def-1", definitionName: "Admissão", definitionCode: "ADM",
  isCorporate: true, defaultPriority: "normal",
  versionId: "ver-1", versionNumber: "2.0", bpmnXml: XML, graph,
  steps: new Map<string, ProcessStepConfig>([
    ["Conferencia", step({
      id: "Conferencia", bpmnElementId: "Conferencia", name: "Conferência cadastral",
      responsibilityMode: "DEPARTMENT", departmentId: "area-dp",
      slaValue: 2, slaUnit: "days", slaBusinessDays: true,
      checklist: ["Conferir CTPS", "Conferir dados bancários"],
      requiredDocuments: ["Contrato assinado"], evidenceRequired: true,
      instructions: "Confira a ficha antes de aprovar.",
    })],
    ["Aprovacao", step({
      id: "Aprovacao", bpmnElementId: "Aprovacao", name: "Aprovação",
      responsibilityMode: "USER", responsibleUserId: "u-1", requiresApproval: true,
      slaValue: 1, slaUnit: "hours",
    })],
  ]),
};

const names = {
  users: new Map([["u-1", "Ana Souza"]]),
  areas: new Map([["area-dp", "Departamento Pessoal"]]),
};

/* -------------------------------------------------------------------------- *
 * Ordem
 * -------------------------------------------------------------------------- */

test("a ordem sai da travessia, e não da ordem do XML", () => {
  // Um diagrama desenhado de trás para frente precisa produzir a mesma leitura.
  assert.deepEqual(orderedSteps(graph).slice(0, 3), ["Conferencia", "Aprovacao", "Fim"]);
});

test("o evento de início não vira etapa de trabalho — ninguém trabalha em 'Início'", () => {
  assert.ok(!orderedSteps(graph).includes("Start"));
});

test("etapa órfã aparece no fim, e não some da lista", () => {
  // Ela existe no desenho. Escondê-la faria a lista mentir sobre o processo, e
  // quem publicou a versão nunca descobriria o erro de modelagem.
  const order = orderedSteps(graph);
  assert.equal(order[order.length - 1], "Orfa");
});

/* -------------------------------------------------------------------------- *
 * Etapas em texto
 * -------------------------------------------------------------------------- */

test("cada etapa diz quem responde, em nome de gente e não de identificador", () => {
  const [conferencia, aprovacao] = summarizeSteps(version, names);
  assert.equal(conferencia.responsible, "Departamento Pessoal");
  assert.equal(aprovacao.responsible, "Ana Souza");
});

test("responsável não configurado é dito, e não inventado", () => {
  const [, , fim] = summarizeSteps(version, names);
  assert.equal(fim.responsible, "Sem responsável definido");
});

test("o prazo da etapa aparece em português, com dia útil quando é o caso", () => {
  const [conferencia, aprovacao, fim] = summarizeSteps(version, names);
  assert.equal(conferencia.slaLabel, "2 dias úteis");
  assert.equal(aprovacao.slaLabel, "1 hora");
  assert.equal(fim.slaLabel, "Sem prazo próprio");
});

test("as exigências da etapa aparecem inteiras — é o que trava o avanço (§44)", () => {
  const [conferencia] = summarizeSteps(version, names);
  assert.deepEqual(conferencia.checklist, ["Conferir CTPS", "Conferir dados bancários"]);
  assert.deepEqual(conferencia.requiredDocuments, ["Contrato assinado"]);
  assert.equal(conferencia.evidenceRequired, true);
  assert.equal(conferencia.instructions, "Confira a ficha antes de aprovar.");
});

test("a etapa diz para onde segue, com o nome do destino", () => {
  const [conferencia, aprovacao] = summarizeSteps(version, names);
  assert.deepEqual(conferencia.nextLabels, ["Aprovação"]);
  assert.deepEqual(aprovacao.nextLabels, ["Concluído"]);
});

test("a etapa final é marcada como final", () => {
  const summary = summarizeSteps(version, names);
  assert.equal(summary.find((item) => item.id === "Fim")?.terminal, true);
  assert.equal(summary.find((item) => item.id === "Conferencia")?.terminal, false);
});

test("a numeração começa na etapa inicial, não no evento de início", () => {
  const [first] = summarizeSteps(version, names);
  assert.equal(first.position, 1);
  assert.equal(first.id, "Conferencia");
});

/* -------------------------------------------------------------------------- *
 * Uso
 * -------------------------------------------------------------------------- */

test("duração vira linguagem de operação", () => {
  assert.equal(durationLabel(null), "—");
  assert.equal(durationLabel(0), "—");
  assert.equal(durationLabel(0.5), "30 min");
  assert.equal(durationLabel(3.25), "3.3 h");
  assert.equal(durationLabel(72), "3.0 dias");
  assert.equal(durationLabel(24 * 40), "40 dias");
});

/* -------------------------------------------------------------------------- *
 * Fronteiras
 * -------------------------------------------------------------------------- */

test("a leitura do processo não decide transição", async () => {
  // Quem autoriza avanço continua sendo `process-instances`, chamado do zero
  // pela rota. Duplicar a decisão aqui criaria duas respostas para a mesma
  // pergunta, e a tela passaria a oferecer o que o servidor recusa.
  const source = await readFile(new URL("../lib/process-usage.ts", import.meta.url), "utf8");
  for (const forbidden of [/evaluateTransition/u, /blockers/u, /UPDATE /u, /prepare\(/u]) {
    assert.ok(!forbidden.test(source), `a leitura passou a decidir: ${forbidden}`);
  }
});

test("o painel da demanda mostra o bloqueio que o servidor devolveu, e não o seu", async () => {
  const panel = await readFile(new URL("../app/painel/features/work/CardProcessPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /api\/cards\/\$\{encodeURIComponent\(cardId\)\}\/process/u);
  assert.match(panel, /transition\.blockers\.map/u, "cada motivo precisa aparecer — resumir faz a pessoa adivinhar");
  assert.match(panel, /disabled=\{!transition\.allowed/u, "destino bloqueado não pode ser clicável");
  assert.ok(!/PROCESS_STEP_CHECKLIST_PENDING/u.test(panel),
    "a tela não pode redigir a própria mensagem de bloqueio: ela divergiria do servidor");
});

test("a ficha operacional não desenha BPMN (§43)", async () => {
  const panel = await readFile(new URL("../app/painel/features/work/ProcessOperationPanel.tsx", import.meta.url), "utf8");
  // Sem os comentários: eles falam de BPMN justamente para explicar a ausência.
  const code = panel.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  for (const forbidden of [/bpmn/iu, /ProcessModeler/u, /<svg/u, /diagram/iu]) {
    assert.ok(!forbidden.test(code), `a leitura operacional voltou a exigir diagrama: ${forbidden}`);
  }
  assert.match(panel, /Iniciar processo/u, "iniciar precisa estar onde se lê o processo (§41)");
});

test("a linha do tempo da demanda reconhece processo e automação (§45)", async () => {
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  for (const event of ["process.instance_started", "process.step_advanced", "integration.demand_created"]) {
    assert.ok(app.includes(`"${event}"`), `o histórico não sabe explicar ${event}`);
  }
  assert.match(app, /Proposta do agente/u,
    "avanço vindo de proposta precisa dizer que foi confirmado por uma pessoa");
});
