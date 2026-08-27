import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CONDITION_OPERATORS,
  describeCondition,
  evaluateCondition,
  parseTransitionConditions,
  unmetConditions,
  type TransitionCondition,
} from "../lib/process-conditions.ts";

/**
 * §25: "validar condição antes da etapa".
 *
 * O motor sabia para onde a demanda pode ir — o desenho responde isso — mas não
 * sob que critério. Estes testes cobram o critério: o conjunto fechado de
 * operadores, o que acontece quando o fato não existe, e a recusa de qualquer
 * caminho que pareça execução de expressão.
 */

const cond = (over: Partial<TransitionCondition> = {}): TransitionCondition => ({
  field: "priority", operator: "equals", value: "urgent", ...over,
});

/* ── Operadores ────────────────────────────────────────────────────────── */

test("igualdade não distingue caixa nem espaço à toa", () => {
  // Quem configura digita "Urgente"; o dado grava "urgent". Reprovar por causa
  // disso faria a regra parecer quebrada sem nada estar quebrado.
  assert.equal(evaluateCondition(cond({ value: "URGENT" }), { priority: "urgent" }), true);
  assert.equal(evaluateCondition(cond({ value: " urgent " }), { priority: "Urgent" }), true);
  assert.equal(evaluateCondition(cond(), { priority: "normal" }), false);
});

test("negação é o oposto exato da igualdade", () => {
  assert.equal(evaluateCondition(cond({ operator: "not_equals" }), { priority: "normal" }), true);
  assert.equal(evaluateCondition(cond({ operator: "not_equals" }), { priority: "urgent" }), false);
});

test("lista aceita vírgula com e sem espaço", () => {
  const entre = cond({ operator: "in", value: "urgent, high" });
  assert.equal(evaluateCondition(entre, { priority: "high" }), true);
  assert.equal(evaluateCondition(entre, { priority: "low" }), false);
  const fora = cond({ operator: "not_in", value: "urgent,high" });
  assert.equal(evaluateCondition(fora, { priority: "low" }), true);
  assert.equal(evaluateCondition(fora, { priority: "urgent" }), false);
});

test("vazio e preenchido olham o fato, não a configuração", () => {
  const vazio = cond({ field: "competence", operator: "is_empty", value: "" });
  assert.equal(evaluateCondition(vazio, { competence: "" }), true);
  assert.equal(evaluateCondition(vazio, { competence: "   " }), true, "só espaço é vazio");
  assert.equal(evaluateCondition(vazio, {}), true, "fato ausente é vazio");
  assert.equal(evaluateCondition(vazio, { competence: "2026-08" }), false);

  const cheio = cond({ field: "competence", operator: "is_not_empty", value: "" });
  assert.equal(evaluateCondition(cheio, { competence: "2026-08" }), true);
  assert.equal(evaluateCondition(cheio, {}), false);
});

test("comparação numérica entende o número escrito em português", () => {
  const maior = cond({ field: "custom:valor", operator: "greater_than", value: "1000" });
  assert.equal(evaluateCondition(maior, { "custom:valor": "1.500,00" }), true);
  assert.equal(evaluateCondition(maior, { "custom:valor": "999,99" }), false);
  assert.equal(evaluateCondition(maior, { "custom:valor": 1500 }), true);

  const menor = cond({ field: "custom:valor", operator: "less_than", value: "1000" });
  assert.equal(evaluateCondition(menor, { "custom:valor": "500" }), true);
});

test("comparar número com o que não é número não libera passagem", () => {
  // Sem sentido não é falso nem verdadeiro — mas, na dúvida, uma etapa não
  // avança. O contrário deixaria um campo mal preenchido abrir o caminho.
  const maior = cond({ field: "custom:valor", operator: "greater_than", value: "1000" });
  assert.equal(evaluateCondition(maior, { "custom:valor": "mil e quinhentos" }), false);
  assert.equal(evaluateCondition(maior, {}), false);
  const bobagem = cond({ field: "custom:valor", operator: "greater_than", value: "muito" });
  assert.equal(evaluateCondition(bobagem, { "custom:valor": "1500" }), false);
});

test("fato ausente faz a condição falhar, nunca passar", () => {
  // É o modo de falhar que importa: se um campo renomeado tornasse a regra
  // inerte, ela pareceria funcionando e não seria.
  for (const operator of ["equals", "in", "greater_than", "less_than"] as const) {
    assert.equal(
      evaluateCondition(cond({ field: "custom:inexistente", operator, value: "1" }), {}),
      false,
      `${operator} com fato ausente não pode passar`,
    );
  }
});

/* ── Leitura do que o modelador grava ──────────────────────────────────── */

test("condição malformada é descartada, e a seta volta a ser incondicional", () => {
  // Descartar em vez de recusar: uma condição corrompida não pode derrubar o
  // processo inteiro. Mas ela também não vira "sempre verdadeira" — some.
  const parsed = parseTransitionConditions({
    Flow_1: [
      { field: "priority", operator: "equals", value: "urgent" },
      { field: "", operator: "equals", value: "x" },
      { field: "priority", operator: "regex", value: ".*" },
      { field: "priority", operator: "equals" },
      "não é objeto",
      null,
    ],
    Flow_vazio: [],
    "": [{ field: "priority", operator: "equals", value: "x" }],
  });
  assert.deepEqual(Object.keys(parsed), ["Flow_1"]);
  // `value` ausente vira string vazia, o que é legítimo para is_empty.
  assert.equal(parsed.Flow_1.length, 2);
  assert.equal(parsed.Flow_1[0].value, "urgent");
});

test("entrada que não é objeto não vira mapa de condições", () => {
  for (const raw of [null, undefined, "texto", 42, [1, 2, 3]]) {
    assert.deepEqual(parseTransitionConditions(raw), {});
  }
});

test("o operador vem de um conjunto fechado", () => {
  // A garantia de segurança inteira mora aqui: não existe caminho em que texto
  // escrito por quem desenha o processo seja interpretado como código.
  assert.deepEqual([...CONDITION_OPERATORS].sort(), [
    "equals", "greater_than", "in", "is_empty", "is_not_empty", "less_than", "not_equals", "not_in",
  ]);
  const parsed = parseTransitionConditions({
    F: [{ field: "x", operator: "process.exit(1)", value: "" }],
  });
  assert.deepEqual(parsed, {});
});

test("um passo não carrega condição sem limite", () => {
  const muitas = Array.from({ length: 40 }, () => ({ field: "priority", operator: "equals", value: "a" }));
  assert.equal(parseTransitionConditions({ F: muitas }).F.length, 12);
});

/* ── O que a tela mostra ───────────────────────────────────────────────── */

test("as condições não atendidas são as que a tela precisa citar", () => {
  const facts = { priority: "normal", competence: "2026-08" };
  const unmet = unmetConditions([
    cond(),
    cond({ field: "competence", operator: "is_not_empty", value: "" }),
  ], facts);
  assert.equal(unmet.length, 1);
  assert.equal(unmet[0].field, "priority");
  // Sem condição nenhuma, nada a cobrar — a seta é incondicional.
  assert.deepEqual(unmetConditions(undefined, facts), []);
  assert.deepEqual(unmetConditions([], facts), []);
});

test("o motivo do bloqueio é escrito em português, não em código", () => {
  // "PROCESS_TRANSITION_CONDITION_UNMET" não ajuda ninguém a destravar a
  // demanda; "Prioridade é urgente" ajuda.
  // O valor é ecoado como foi configurado — traduzi-lo seria inventar um
  // vocabulário que o dado não tem.
  assert.equal(describeCondition(cond()), "Prioridade é urgent");
  assert.equal(
    describeCondition(cond({ field: "competence", operator: "is_not_empty", value: "" })),
    "Competência está preenchido",
  );
  assert.equal(
    describeCondition(cond({ field: "custom:contrato", operator: "in", value: "CLT, PJ" })),
    "contrato está entre CLT, PJ",
  );
});

/* ── A tela e o servidor falam a mesma língua ──────────────────────────── */

test("o saneador de gravação aceita as regras, em vez de descartá-las", async () => {
  // Descoberto ao construir a tela: `sanitizeProcessStepConfigs` monta o objeto
  // `settings` campo a campo. Sem estas quatro linhas, a condição configurada
  // no modelador sumia no caminho até o banco — e o motor executaria um
  // processo sem a regra que alguém acabou de escrever, sem erro nenhum.
  const { sanitizeProcessStepConfigs } = await import("../lib/process-management.ts");
  const [config] = sanitizeProcessStepConfigs([{
    bpmnElementId: "Task_1",
    settings: {
      entryRules: [{ field: "priority", operator: "equals", value: "urgent" }],
      exitRules: [{ field: "competence", operator: "is_not_empty", value: "" }],
      transitions: { Flow_3: [{ field: "custom:contrato", operator: "in", value: "CLT,PJ" }] },
      blockingIntegrations: ["Sankhya", "  SOLIDES  "],
    },
  }]);
  assert.equal(config.settings.entryRules.length, 1);
  assert.equal(config.settings.exitRules[0].field, "competence");
  assert.equal(config.settings.transitions.Flow_3[0].operator, "in");
  // Canal é comparado em minúsculas contra o status da integração; normalizar
  // na gravação evita depender de como quem digitou usou a tecla shift.
  assert.deepEqual(config.settings.blockingIntegrations, ["sankhya", "solides"]);
});

test("regra inválida não chega ao banco", async () => {
  // O saneador usa o mesmo parser do motor. Guardar o que a execução vai
  // descartar depois produziria uma regra que existe na tela e não vale nada.
  const { sanitizeProcessStepConfigs } = await import("../lib/process-management.ts");
  const [config] = sanitizeProcessStepConfigs([{
    bpmnElementId: "Task_1",
    settings: { exitRules: [{ field: "x", operator: "eval", value: "1" }, { field: "", operator: "equals", value: "y" }] },
  }]);
  assert.deepEqual(config.settings.exitRules, []);
});

test("etapa sem regra nenhuma grava listas vazias, não indefinido", async () => {
  const { sanitizeProcessStepConfigs } = await import("../lib/process-management.ts");
  const [config] = sanitizeProcessStepConfigs([{ bpmnElementId: "Task_1", settings: {} }]);
  assert.deepEqual(config.settings.entryRules, []);
  assert.deepEqual(config.settings.exitRules, []);
  assert.deepEqual(config.settings.transitions, {});
  assert.deepEqual(config.settings.blockingIntegrations, []);
});

test("a tela oferece exatamente os operadores que o servidor aceita", async () => {
  // Uma tela que ofereça um operador a mais entrega ao usuário uma regra que o
  // servidor descarta em silêncio — o pior tipo de divergência, porque parece
  // configurada.
  const modeler = await readFile(
    new URL("../app/painel/features/processes/ProcessModeler.tsx", import.meta.url), "utf8");
  assert.match(modeler, /import \{ CONDITION_OPERATORS, FACT_LABELS \} from "@\/lib\/process-conditions"/u);
  assert.match(modeler, /CONDITION_OPERATORS\.map/u, "a lista de operadores precisa vir do módulo, não ser recopiada");
  // E todo operador tem rótulo em português.
  const labels = modeler.slice(modeler.indexOf("const operatorLabel"), modeler.indexOf("const noValueOperators"));
  for (const operator of CONDITION_OPERATORS) {
    assert.match(labels, new RegExp(`${operator}:`, "u"), `${operator} sem rótulo na tela`);
  }
});
