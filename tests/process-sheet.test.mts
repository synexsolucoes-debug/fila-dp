import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseBpmnGraph } from "../lib/bpmn-graph.ts";
import {
  summarizeAutomations, summarizeDocuments, summarizeRules,
  type StepAutomationRow,
} from "../lib/process-sheet.ts";
import type { ProcessStepConfig, PublishedProcessVersion } from "../lib/process-instances.ts";

/**
 * §31: as abas do processo.
 *
 * O que estes testes cobram não é a existência das abas — é que elas digam a
 * verdade sobre a configuração gravada. Uma aba de documentos que omitisse
 * *como* a exigência é conferida, ou uma de automações que listasse o desenho
 * como se fosse automação, pareceriam completas e fariam alguém decidir errado.
 */

const XML = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P1">
    <startEvent id="Start" name="Início"><outgoing>F0</outgoing></startEvent>
    <userTask id="Documentacao" name="Documentação"><incoming>F0</incoming><outgoing>F1</outgoing><outgoing>F2</outgoing></userTask>
    <userTask id="Registro" name="Registro"><incoming>F1</incoming><outgoing>F3</outgoing></userTask>
    <userTask id="Excecao" name="Tratamento de exceção"><incoming>F2</incoming></userTask>
    <endEvent id="Fim" name="Concluído"><incoming>F3</incoming></endEvent>
    <sequenceFlow id="F0" sourceRef="Start" targetRef="Documentacao" />
    <sequenceFlow id="F1" sourceRef="Documentacao" targetRef="Registro" />
    <sequenceFlow id="F2" sourceRef="Documentacao" targetRef="Excecao" />
    <sequenceFlow id="F3" sourceRef="Registro" targetRef="Fim" />
  </process>
</definitions>`;

const step = (overrides: Partial<ProcessStepConfig>): ProcessStepConfig => ({
  id: "", bpmnElementId: "", stepType: "TASK", name: "", instructions: "",
  departmentId: "", responsibleUserId: "", responsibilityMode: "ANY",
  slaValue: 0, slaUnit: "hours", slaBusinessDays: false,
  requesterDepartmentId: "", responsibleDepartmentId: "",
  checklist: [], requiredDocuments: [], evidenceRequired: false,
  requiresApproval: false, approverUserId: "", approverDepartmentId: "",
  demandPriority: "normal", transitions: {}, entryRules: [], exitRules: [],
  blockingIntegrations: [], documentProof: "declared",
  tasks: [], automations: [], ...overrides,
});

const automationRow = (overrides: Partial<StepAutomationRow>): StepAutomationRow => ({
  bpmnElementId: "", createDemand: false, demandType: "", demandPriority: "normal",
  demandSlaValue: 0, demandSlaUnit: "hours", requesterDepartmentId: "",
  responsibleDepartmentId: "", optionalDocuments: [], ...overrides,
});

const names = {
  users: new Map([["u-1", "Ana Souza"]]),
  areas: new Map([["area-dp", "Departamento Pessoal"], ["area-ti", "Tecnologia"]]),
};

const version: PublishedProcessVersion = {
  definitionId: "def-1", definitionName: "Admissão", definitionCode: "ADM",
  isCorporate: true, defaultPriority: "normal",
  versionId: "ver-1", versionNumber: "3.0", bpmnXml: XML, graph: parseBpmnGraph(XML),
  steps: new Map<string, ProcessStepConfig>([
    ["Documentacao", step({
      id: "Documentacao", bpmnElementId: "Documentacao", name: "Documentação",
      checklist: ["Conferir CPF", "Conferir RG"],
      requiredDocuments: ["CPF", "Comprovante de residência"],
      exitRules: [{ field: "competence", operator: "is_not_empty", value: "" }],
      transitions: { F2: [{ field: "priority", operator: "equals", value: "urgent" }] },
    })],
    ["Registro", step({
      id: "Registro", bpmnElementId: "Registro", name: "Registro",
      requiredDocuments: ["Contrato", "cpf"], evidenceRequired: true,
      requiresApproval: true, approverUserId: "u-1",
      entryRules: [{ field: "custom:aso", operator: "is_not_empty", value: "" }],
      blockingIntegrations: ["sankhya"],
    })],
    ["Excecao", step({ id: "Excecao", bpmnElementId: "Excecao", name: "Tratamento de exceção" })],
  ]),
};

const automation = new Map<string, StepAutomationRow>([
  ["Registro", automationRow({
    bpmnElementId: "Registro", createDemand: true, demandType: "Cadastro no ERP",
    demandPriority: "high", demandSlaValue: 4, demandSlaUnit: "hours",
    responsibleDepartmentId: "area-ti",
  })],
  ["Documentacao", automationRow({
    bpmnElementId: "Documentacao", optionalDocuments: ["Certidão de nascimento"],
  })],
]);

/* ── Documentos (§26) ──────────────────────────────────────────────────── */

test("os documentos são agrupados pelo documento, não pela etapa", () => {
  // A pergunta de quem abre a aba é "o que preciso juntar?", não "o que a etapa
  // 3 pede". A lista por etapa já existe no fluxo.
  const documents = summarizeDocuments(version, automation);
  const cpf = documents.find((item) => item.name === "CPF");
  assert.ok(cpf, "CPF precisa aparecer uma vez só");
  assert.deepEqual(cpf.steps, ["Documentação", "Registro"], "e citar as duas etapas, na ordem do processo");
  assert.equal(documents.filter((item) => item.name.toLowerCase() === "cpf").length, 1);
});

test("o mesmo documento escrito em caixas diferentes continua sendo um só", () => {
  // "CPF" na Documentação e "cpf" no Registro são a mesma exigência; separá-los
  // faria a lista cobrar duas vezes o que se junta uma.
  const documents = summarizeDocuments(version, automation);
  assert.equal(documents.filter((item) => item.name.toLocaleLowerCase("pt-BR") === "cpf").length, 1);
});

test("a aba diz se a exigência é verificada ou apenas declarada", () => {
  /* É a diferença que decide se a auditoria confia na etapa: hoje documento
     obrigatório é item de checklist, e marcar é declarar. Só a etapa com
     evidência exigida recusa avanço sem anexo. Esconder isso faria a tela
     prometer uma conferência que o produto não faz. */
  const documents = summarizeDocuments(version, automation);
  assert.equal(documents.find((item) => item.name === "Contrato")?.proof, "evidence");
  assert.equal(documents.find((item) => item.name === "Comprovante de residência")?.proof, "declared");
  // O CPF é pedido nas duas: basta uma etapa conferir de verdade para não ser
  // subestimado.
  assert.equal(documents.find((item) => item.name === "CPF")?.proof, "evidence");
});

test("documento opcional aparece marcado como opcional", () => {
  const documents = summarizeDocuments(version, automation);
  const certidao = documents.find((item) => item.name === "Certidão de nascimento");
  assert.equal(certidao?.required, false);
  assert.equal(documents.find((item) => item.name === "Contrato")?.required, true);
});

test("processo que não pede documento devolve lista vazia, e não linha em branco", () => {
  const vazio: PublishedProcessVersion = { ...version, steps: new Map() };
  assert.deepEqual(summarizeDocuments(vazio), []);
});

/* ── Regras e validações (§25) ─────────────────────────────────────────── */

test("etapa sem regra nenhuma não entra na lista", () => {
  // Quinze linhas vazias escondem as três que importam.
  const rules = summarizeRules(version, names);
  assert.ok(!rules.some((item) => item.stepId === "Excecao"));
  assert.ok(!rules.some((item) => item.stepId === "Fim"));
});

test("a condição da seta é lida por destino, com o nome do destino", () => {
  const rules = summarizeRules(version, names);
  const documentacao = rules.find((item) => item.stepId === "Documentacao");
  assert.deepEqual(documentacao?.transitions, [
    { target: "Tratamento de exceção", conditions: ["Prioridade é urgent"] },
  ]);
  // A seta para Registro não tem condição — e uma seta incondicional não vira
  // "condição sempre verdadeira", ela some.
  assert.equal(documentacao?.transitions.length, 1);
});

test("regra de entrada e regra de saída não se misturam", () => {
  // O motivo do bloqueio é diferente, e quem foi barrado precisa saber qual das
  // duas o barrou.
  const rules = summarizeRules(version, names);
  assert.deepEqual(rules.find((item) => item.stepId === "Documentacao")?.exit, ["Competência está preenchido"]);
  assert.deepEqual(rules.find((item) => item.stepId === "Documentacao")?.entry, []);
  assert.deepEqual(rules.find((item) => item.stepId === "Registro")?.entry, ["aso está preenchido"]);
});

test("as exigências da etapa são ditas por extenso, com quem aprova", () => {
  const registro = summarizeRules(version, names).find((item) => item.stepId === "Registro");
  assert.ok(registro?.requirements.some((item) => item.includes("2 documento(s)")));
  assert.ok(registro?.requirements.some((item) => item.includes("Exige anexo")));
  assert.ok(registro?.requirements.some((item) => item.includes("Ana Souza")));
  assert.ok(registro?.requirements.some((item) => item.includes("não pode ser quem executou")),
    "a anti-autoaprovação existe no motor e precisa ser dita antes de alguém desenhar em cima dela");
});

test("o checklist entra pela contagem, porque é o que trava o avanço", () => {
  const documentacao = summarizeRules(version, names).find((item) => item.stepId === "Documentacao");
  assert.ok(documentacao?.requirements.some((item) => item.includes("checklist pendente (2)")));
});

test("o canal de integração que trava a conclusão é nomeado", () => {
  const registro = summarizeRules(version, names).find((item) => item.stepId === "Registro");
  assert.deepEqual(registro?.blockingIntegrations, ["sankhya"]);
});

/* ── Automações (§27) ──────────────────────────────────────────────────── */

test("só entra na aba de automações o que o produto executa sozinho", () => {
  /* O encadeamento "etapa concluída → próxima etapa" é o desenho, já lido na
     aba de fluxo. Listá-lo aqui encheria a aba sem acrescentar nada, e faria
     parecer configurado o que é apenas desenhado. */
  const automations = summarizeAutomations(version, automation, names);
  assert.equal(automations.length, 1);
  assert.equal(automations[0].stepId, "Registro");
});

test("a automação é escrita em português, com área, prioridade e prazo", () => {
  const [item] = summarizeAutomations(version, automation, names);
  assert.match(item.trigger, /Registro/u);
  assert.match(item.effect, /Cadastro no ERP/u);
  assert.match(item.effect, /Tecnologia/u);
  assert.match(item.effect, /prioridade alta/u);
  assert.match(item.effect, /prazo de 4 horas/u);
});

test("prazo de uma unidade não sai no plural", () => {
  const uma = new Map<string, StepAutomationRow>([["Registro", automationRow({
    bpmnElementId: "Registro", createDemand: true, demandSlaValue: 1, demandSlaUnit: "days",
  })]]);
  assert.match(summarizeAutomations(version, uma, names)[0].effect, /prazo de 1 dia\b/u);
});

test("processo sem automação nenhuma devolve lista vazia", () => {
  assert.deepEqual(summarizeAutomations(version, new Map(), names), []);
});

/* ── Fronteiras ────────────────────────────────────────────────────────── */

test("a leitura das abas não decide transição nem escreve no banco", async () => {
  // Quem autoriza avanço continua sendo `process-instances`, chamado do zero
  // pela rota. Duplicar a decisão aqui criaria duas respostas para a mesma
  // pergunta, e a ficha passaria a prometer o que o servidor recusa.
  const source = await readFile(new URL("../lib/process-sheet.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  for (const forbidden of [/evaluateTransition/u, /evaluateCondition/u, /UPDATE /u, /prepare\(/u]) {
    assert.ok(!forbidden.test(code), `a leitura passou a decidir: ${forbidden}`);
  }
});

test("a ficha tem as seis abas que a §31 pede", async () => {
  const view = await readFile(
    new URL("../app/painel/features/processes/ProcessManagementView.tsx", import.meta.url), "utf8");
  const block = view.slice(view.indexOf("const detailTabs"), view.indexOf("const sheetSections"));
  for (const label of [
    "Fluxo do processo", "Descrição", "Documentos", "Regras e validações", "Automações",
    "Histórico de versões",
  ]) {
    assert.ok(block.includes(label), `a §31 pede a aba «${label}»`);
  }
});

test("as quatro abas de ficha saem do mesmo componente montado", async () => {
  /* Quatro componentes fariam quatro pedidos da mesma rota, e abririam caminho
     para quatro leituras divergentes do mesmo processo — o pior tipo de
     divergência, porque cada tela parece certa sozinha. */
  const view = await readFile(
    new URL("../app/painel/features/processes/ProcessManagementView.tsx", import.meta.url), "utf8");
  assert.equal((view.match(/<ProcessOperationPanel/gu) ?? []).length, 1);
  assert.match(view, /section=\{sheetSection\}/u);
});

test("a aba de automações não inventa que a regra de quadro é do processo", async () => {
  // `fdp_automation_rules` é do workspace inteiro e não referencia processo.
  // Mostrá-la aqui faria alguém acreditar que desligar a regra afeta só esta
  // admissão.
  const panel = await readFile(
    new URL("../app/painel/features/work/ProcessOperationPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /Configurações › Automações/u,
    "a tela precisa dizer onde as regras de quadro moram, em vez de omitir");
});

/* ── Rascunho (§31, §103) ──────────────────────────────────────────────── */

test("a ficha de um processo em rascunho mostra o que está configurado", async () => {
  /* Achado ao abrir a ficha de um processo recém-criado, com o produto de pé:
     as quatro abas de dados abriam com banner vermelho — "Só uma versão
     publicada pode gerar demanda" — e nenhum conteúdo. O produto recusava
     *ler* o que ele mesmo mandava configurar, no estado em que todo processo
     nasce.

     Ler e executar são coisas diferentes. A recusa continua, e no mesmo lugar:
     `loadPublishedVersion` é a porta da execução. */
  const route = await readFile(
    new URL("../app/api/processes/[id]/usage/route.ts", import.meta.url), "utf8");
  assert.match(route, /loadVersionForReading/u);
  // Sem os comentários: eles citam a porta estrita justamente para explicar por
  // que ela não é usada aqui.
  const codigo = route.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.ok(!/loadPublishedVersion/u.test(codigo),
    "a ficha voltou a exigir versão publicada para apenas mostrar a configuração");
  assert.match(route, /published: version\.published/u);
});

test("rascunho não ganha o botão de iniciar processo", async () => {
  // Mostrar sem permitir instanciar é a única leitura segura: a rota de
  // instanciação recusaria, e oferecer o botão seria prometer o que o servidor
  // nega.
  const route = await readFile(
    new URL("../app/api/processes/[id]/usage/route.ts", import.meta.url), "utf8");
  const bloco = route.slice(route.indexOf("permissions: {"));
  assert.match(bloco, /start: version\.published/u);
});

test("a instanciação continua exigindo versão publicada", async () => {
  // O guard que impede rascunho de gerar demanda não pode ter sido afrouxado
  // junto: é ele que impede o caminho lateral.
  const engine = await readFile(new URL("../lib/process-instances.ts", import.meta.url), "utf8");
  assert.match(engine, /options\.requirePublished && !published/u);
  const instanciar = await readFile(
    new URL("../app/api/processes/versions/[id]/instantiate/route.ts", import.meta.url), "utf8");
  assert.match(instanciar, /loadPublishedVersion/u,
    "a rota de instanciação precisa continuar usando a porta estrita");
});

test("o painel mostra o aviso de rascunho junto do conteúdo, não no lugar dele", async () => {
  const panel = await readFile(
    new URL("../app/painel/features/work/ProcessOperationPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /!payload\.published && !payload\.version/u,
    "só processo sem versão nenhuma pode ficar sem conteúdo");
  assert.match(panel, /\{rascunho\}<DocumentsSection/u);
});
