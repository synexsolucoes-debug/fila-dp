import assert from "node:assert/strict";
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
