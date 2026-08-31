import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceBlockingTasks, automationsFor, blockedTasks, parseStepAutomations,
  parseTaskTemplates, taskCompletionBlocker, taskDeadline, taskKey, taskOf,
  type DemandTask, type TaskTemplate,
} from "../lib/process-tasks.ts";
import { stepChecklist, stepConfigOf, stepTasks, type ProcessStepConfig } from "../lib/process-instances.ts";

/* §24 e §41: a tarefa deixa de ser uma string dentro da etapa.
   Os testes abaixo cobrem as três coisas que essa mudança precisa garantir —
   que o desenho novo funciona, que o desenho antigo continua funcionando
   exatamente como antes, e que a regra de conclusão é conferida contra a prova
   da própria tarefa. */

const step = (overrides: Partial<ProcessStepConfig> = {}): ProcessStepConfig => ({
  id: "cfg", bpmnElementId: "Task_1", stepType: "USER_TASK", name: "Documentação",
  instructions: "", departmentId: "", responsibleUserId: "", responsibilityMode: "ANY",
  slaValue: 0, slaUnit: "hours", slaBusinessDays: false,
  requesterDepartmentId: "", responsibleDepartmentId: "",
  checklist: [], requiredDocuments: [], evidenceRequired: false,
  requiresApproval: false, approverUserId: "", approverDepartmentId: "",
  demandPriority: "normal", transitions: {}, entryRules: [], exitRules: [],
  blockingIntegrations: [], documentProof: "declared",
  tasks: [], automations: [], ...overrides,
});

const task = (overrides: Partial<DemandTask> = {}): DemandTask => ({
  id: "t1", cardId: "c1", stepId: "Task_1", templateKey: "t1", title: "Tarefa",
  description: "", instructions: "", completed: false, position: 1000,
  areaId: "", assigneeUserId: "", assigneeRole: "",
  slaValue: 0, slaUnit: "hours", startedAt: null, dueAt: null,
  completedAt: null, completedBy: "",
  required: true, blocksAdvance: true, evidenceRequired: false,
  documentRequired: "", completionRule: "manual", dependsOn: [],
  attachmentCount: 0, attachmentNames: [], ...overrides,
});

/* -------------------------------------------------------------------------- *
 * Retrocompatibilidade (§48, §108)
 * -------------------------------------------------------------------------- */

test("etapa sem tarefas-modelo continua produzindo o checklist de sempre", () => {
  const config = step({ checklist: ["Conferir CTPS", "Conferir CPF"] });
  assert.deepEqual(stepChecklist(config), ["Conferir CTPS", "Conferir CPF"]);
});

test("tarefa vinda de checklist nasce obrigatória e bloqueante", () => {
  // É a regra que o motor sempre aplicou: todo item pendente travava a etapa.
  // Se este teste cair, demanda aberta antes da 0072 mudou de comportamento.
  const [first] = stepTasks(step({ checklist: ["Conferir CTPS"] }));
  assert.equal(first.required, true);
  assert.equal(first.blocksAdvance, true);
  assert.equal(first.completionRule, "manual");
});

test("linha sem as colunas novas é lida como obrigatória e bloqueante", () => {
  // A demanda gravada antes da migration não traz `required` nem
  // `blocks_advance` em consultas antigas; o padrão precisa ser o de antes.
  const legacy = taskOf({ id: "x", card_id: "c", title: "Item legado", completed: 0, position: 1000 });
  assert.equal(legacy.required, true);
  assert.equal(legacy.blocksAdvance, true);
  assert.equal(legacy.stepId, "");
});

test("item solto continua travando a etapa atual", () => {
  // `process_step_id` vazio é o item que a pessoa adiciona à mão e o que toda
  // demanda legada tem. Ele sempre contou para a etapa corrente.
  const blocking = advanceBlockingTasks([task({ id: "solto", stepId: "" })], "Task_1");
  assert.equal(blocking.length, 1);
});

/* -------------------------------------------------------------------------- *
 * O que §24 acrescenta
 * -------------------------------------------------------------------------- */

test("tarefa opcional não trava o avanço", () => {
  const tasks = [
    task({ id: "obrigatoria", title: "Conferir CPF" }),
    task({ id: "opcional", title: "Anotar observação", required: false }),
  ];
  assert.deepEqual(advanceBlockingTasks(tasks, "Task_1").map((item) => item.id), ["obrigatoria"]);
});

test("tarefa obrigatória que não trava o avanço fica de fora do bloqueio", () => {
  // Obrigatória e bloqueante são perguntas diferentes: a primeira diz que o
  // trabalho precisa acontecer, a segunda que ele precisa acontecer *agora*.
  const tasks = [task({ id: "depois", required: true, blocksAdvance: false })];
  assert.deepEqual(advanceBlockingTasks(tasks, "Task_1"), []);
});

test("tarefa concluída sai do bloqueio", () => {
  const tasks = [task({ id: "pronta", completed: true })];
  assert.deepEqual(advanceBlockingTasks(tasks, "Task_1"), []);
});

test("o desenho declara o que a tarefa exige, e o padrão é obrigatória", () => {
  const [tarefa] = parseTaskTemplates({
    tasksJson: [{ name: "Conferir CPF", slaValue: 4, slaUnit: "hours" }],
  });
  assert.equal(tarefa.key, "conferir-cpf");
  assert.equal(tarefa.required, true, "campo ausente não pode virar tarefa dispensável");
  assert.equal(tarefa.blocksAdvance, true);
  assert.equal(tarefa.slaValue, 4);
});

test("a chave da tarefa perde acento e pontuação", () => {
  assert.equal(taskKey("Conferir Comprovante de Residência"), "conferir-comprovante-de-residencia");
});

test("nomes repetidos no desenho não colapsam em uma tarefa só", () => {
  const tasks = parseTaskTemplates({ tasksJson: [{ name: "Conferir" }, { name: "Conferir" }] });
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0].key, tasks[1].key);
});

/* -------------------------------------------------------------------------- *
 * Dependência (§24)
 * -------------------------------------------------------------------------- */

test("tarefa dependente fica bloqueada enquanto a anterior não conclui", () => {
  const receber = task({ id: "a", templateKey: "receber", title: "Receber documentos" });
  const conferir = task({ id: "b", templateKey: "conferir", title: "Conferir CPF", dependsOn: ["receber"] });
  const blocked = blockedTasks([receber, conferir]);
  assert.equal(blocked.has("a"), false);
  assert.equal(blocked.get("b")?.code, "TASK_DEPENDENCY_PENDING");
  assert.match(blocked.get("b")!.reason, /Receber documentos/u);
});

test("concluída a anterior, a dependente libera", () => {
  const receber = task({ id: "a", templateKey: "receber", completed: true });
  const conferir = task({ id: "b", templateKey: "conferir", dependsOn: ["receber"] });
  assert.equal(blockedTasks([receber, conferir]).has("b"), false);
});

test("dependência circular é reportada como ciclo, e não como espera eterna", () => {
  // Sem esta detecção, as duas tarefas ficariam bloqueadas para sempre e a
  // mensagem diria "depende de X" — mandando a pessoa resolver o irresolvível.
  const a = task({ id: "a", templateKey: "a", dependsOn: ["b"] });
  const b = task({ id: "b", templateKey: "b", dependsOn: ["a"] });
  const blocked = blockedTasks([a, b]);
  assert.equal(blocked.get("a")?.code, "TASK_DEPENDENCY_CYCLE");
  assert.equal(blocked.get("b")?.code, "TASK_DEPENDENCY_CYCLE");
});

test("dependência apontando para tarefa inexistente não trava nada", () => {
  // O desenho pode ter perdido a tarefa referenciada numa edição. Travar por
  // uma dependência que não existe seria parar a operação por erro de cadastro.
  const only = task({ id: "a", templateKey: "a", dependsOn: ["fantasma"] });
  assert.equal(blockedTasks([only]).has("a"), false);
});

/* -------------------------------------------------------------------------- *
 * Regra de conclusão e prova por tarefa (§41, §43)
 * -------------------------------------------------------------------------- */

test("tarefa que exige evidência recusa a marcação sem anexo nela", () => {
  const alvo = task({ completionRule: "evidence" });
  assert.equal(taskCompletionBlocker(alvo, new Map())?.code, "TASK_EVIDENCE_REQUIRED");
});

test("evidência anexada na própria tarefa libera a marcação", () => {
  const alvo = task({ completionRule: "evidence", attachmentCount: 1, attachmentNames: ["foto.png"] });
  assert.equal(taskCompletionBlocker(alvo, new Map()), null);
});

test("o documento é conferido contra os anexos da tarefa, não os da demanda", () => {
  /* É o furo que §43 aponta: antes, um comprovante enviado em qualquer etapa
     satisfazia a exigência escrita nesta. Aqui a tarefa não tem anexo nenhum —
     o que a demanda tem em outro lugar não conta. */
  const alvo = task({ completionRule: "document", documentRequired: "Comprovante de residência" });
  assert.equal(taskCompletionBlocker(alvo, new Map())?.code, "TASK_DOCUMENT_REQUIRED");

  const comProva = task({
    completionRule: "document", documentRequired: "Comprovante de residência",
    attachmentCount: 1, attachmentNames: ["comprovante-residencia.pdf"],
  });
  assert.equal(taskCompletionBlocker(comProva, new Map()), null);
});

test("arquivo com nome de outro documento não atende a exigência", () => {
  const alvo = task({
    completionRule: "document", documentRequired: "Comprovante de residência",
    attachmentCount: 1, attachmentNames: ["contrato-social.pdf"],
  });
  assert.equal(taskCompletionBlocker(alvo, new Map())?.code, "TASK_DOCUMENT_REQUIRED");
});

test("a dependência vem antes da prova na ordem dos bloqueios", () => {
  // Pedir a evidência de uma tarefa que ainda nem pode começar manda a pessoa
  // produzir prova de trabalho que não é hora de fazer.
  const alvo = task({ id: "b", templateKey: "b", completionRule: "evidence", dependsOn: ["a"] });
  const antes = task({ id: "a", templateKey: "a" });
  const blocker = taskCompletionBlocker(alvo, blockedTasks([antes, alvo]));
  assert.equal(blocker?.code, "TASK_DEPENDENCY_PENDING");
});

/* -------------------------------------------------------------------------- *
 * Prazo da tarefa
 * -------------------------------------------------------------------------- */

test("tarefa sem SLA próprio herda o prazo da etapa", () => {
  const modelo = { slaValue: 0, slaUnit: "hours" } as Pick<TaskTemplate, "slaValue" | "slaUnit">;
  assert.equal(taskDeadline(modelo, "2026-09-01T12:00:00.000Z"), "2026-09-01T12:00:00.000Z");
});

test("tarefa com SLA próprio calcula o prazo dela", () => {
  const agora = Date.parse("2026-09-01T12:00:00.000Z");
  const modelo = { slaValue: 2, slaUnit: "hours" } as Pick<TaskTemplate, "slaValue" | "slaUnit">;
  assert.equal(taskDeadline(modelo, null, agora), "2026-09-01T14:00:00.000Z");
});

/* -------------------------------------------------------------------------- *
 * Documento obrigatório da etapa vira tarefa (§26 + §24)
 * -------------------------------------------------------------------------- */

test("documento obrigatório da etapa entra como tarefa, sem duplicar", () => {
  const tasks = stepTasks(step({
    tasks: parseTaskTemplates({ tasksJson: [{ name: "Documento obrigatório: CPF" }] }),
    requiredDocuments: ["CPF", "RG"],
  }));
  // "CPF" já estava desenhada à mão; só "RG" precisa ser acrescentada.
  assert.deepEqual(tasks.map((item) => item.name), ["Documento obrigatório: CPF", "Documento obrigatório: RG"]);
});

test("com conferência por anexo, a tarefa de documento exige o arquivo", () => {
  const [tarefa] = stepTasks(step({ requiredDocuments: ["ASO"], documentProof: "attached" }));
  assert.equal(tarefa.completionRule, "document");
  assert.equal(tarefa.documentRequired, "ASO");
});

test("com conferência declarada, marcar continua bastando", () => {
  // Apertar isto para todo mundo pararia demanda que hoje anda (§48).
  const [tarefa] = stepTasks(step({ requiredDocuments: ["ASO"], documentProof: "declared" }));
  assert.equal(tarefa.completionRule, "manual");
});

/* -------------------------------------------------------------------------- *
 * Configuração parcial: o painel inteiro dependia disto
 * -------------------------------------------------------------------------- */

test("configuração sem as listas não derruba quem só quer contar tarefas", () => {
  /* `GET /api/workspace` respondia 500 para todo workspace com demanda em
     processo: o snapshot montava uma configuração parcial para contar o total
     previsto, e `stepTasks` lia `config.tasks.length` sem conferir que a lista
     tinha vindo. Um `TypeError` numa contagem derrubava a montagem do painel
     inteiro — quadro, demandas, empresas —, e a tela abria em erro. */
  assert.deepEqual(stepChecklist({ checklist: ["Conferir CTPS"] }), ["Conferir CTPS"]);
  assert.deepEqual(stepChecklist({ requiredDocuments: ["ASO"] }), ["Documento obrigatório: ASO"]);
  assert.deepEqual(stepTasks({}), []);
});

test("o total previsto lê as colunas da etapa, não o settings_json", () => {
  /* `checklist`, documentos e tarefas-modelo moram em coluna própria de
     `fdp_process_step_configs`; `settings_json` guarda nome, instruções e
     condições. A contagem que os procurava lá dentro achava sempre vazio e
     dizia que a versão não previa tarefa nenhuma. Ler a linha pelo mesmo
     `stepConfigOf` da execução é o que faz o denominador do "7 de 18" ser o
     mesmo número que o avanço materializa. */
  const linha = {
    id: "cfg", bpmn_element_id: "Task_1", process_version_id: "v1",
    checklist_json: ["Conferir CTPS"],
    required_documents_json: ["ASO"],
    settings_json: { name: "Documentação" },
  };
  assert.deepEqual(stepChecklist(stepConfigOf(linha)), ["Conferir CTPS", "Documento obrigatório: ASO"]);
});

test("a etapa que desenhou tarefas-modelo conta por elas", () => {
  const linha = {
    id: "cfg", bpmn_element_id: "Task_1", process_version_id: "v1",
    checklist_json: ["Conferir CTPS"],
    tasks_json: [{ name: "Abrir dossiê" }, { name: "Conferir CTPS" }],
  };
  // `tasksJson` manda quando existe: o checklist não soma por fora dele.
  assert.deepEqual(stepChecklist(stepConfigOf(linha)), ["Abrir dossiê", "Conferir CTPS"]);
});

/* -------------------------------------------------------------------------- *
 * Automações da etapa (§27)
 * -------------------------------------------------------------------------- */

test("os cinco gatilhos do briefing são reconhecidos", () => {
  const rules = parseStepAutomations([
    { trigger: "step_entered", action: "create_task", label: "Liberar acesso" },
    { trigger: "step_completed", action: "record_event", eventName: "process.step_advanced" },
    { trigger: "task_overdue", action: "notify_responsible" },
    { trigger: "all_required_done", action: "notify_responsible" },
    { trigger: "process_completed", action: "record_event", eventName: "process.instance_completed" },
  ]);
  assert.equal(rules.length, 5);
  assert.deepEqual(rules.map((rule) => rule.trigger), [
    "step_entered", "step_completed", "task_overdue", "all_required_done", "process_completed",
  ]);
});

test("evento fora do catálogo é descartado, e a automação com ele também", () => {
  /* Um nome inventado viraria um evento que nenhum webhook de cliente
     reconhece — descoberto só quando a integração de alguém não disparou. */
  const rules = parseStepAutomations([
    { trigger: "step_completed", action: "record_event", eventName: "processo.acabou" },
  ]);
  assert.deepEqual(rules, []);
});

test("automação que cria tarefa sem título não é gravada", () => {
  assert.deepEqual(parseStepAutomations([{ trigger: "step_entered", action: "create_task" }]), []);
});

test("automationsFor separa os gatilhos", () => {
  const rules = parseStepAutomations([
    { trigger: "step_entered", action: "notify_responsible", label: "Chegou" },
    { trigger: "task_overdue", action: "notify_responsible", label: "Venceu" },
  ]);
  assert.deepEqual(automationsFor(rules, "task_overdue").map((rule) => rule.label), ["Venceu"]);
});

test("etapa sem automações não inventa nenhuma", () => {
  assert.deepEqual(parseStepAutomations(undefined), []);
  assert.deepEqual(parseStepAutomations({ trigger: "step_entered" }), []);
});
