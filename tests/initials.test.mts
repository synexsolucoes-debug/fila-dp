import assert from "node:assert/strict";
import test from "node:test";
import { initialsOf } from "../lib/initials.ts";

/**
 * Casos do pior caso realista (break-ui) que quebravam o avatar no quadro:
 * emoji no começo do nome virava "�", e a regra antiga pegava as duas
 * primeiras palavras em vez da primeira e da última.
 */
test("iniciais usam primeira e última palavra", () => {
  assert.equal(initialsOf("Aleksandra Wiśniewska-Kowalczyk de Albuquerque Figueiredo"), "AF");
  assert.equal(initialsOf("Ana de Souza"), "AS");
});

test("nome de uma palavra só dá uma inicial", () => {
  assert.equal(initialsOf("Jo"), "J");
});

test("emoji e número não viram meio caractere no avatar", () => {
  assert.equal(initialsOf("🧑‍💼 Bruno"), "B");
  assert.equal(initialsOf("2º turno Carla"), "TC");
  assert.doesNotMatch(initialsOf("🧑‍💼 Bruno"), /�|[\uD800-\uDFFF]/u);
});

test("acento e letra fora do latim continuam inteiros", () => {
  assert.equal(initialsOf("Érica Ñúñez"), "ÉÑ");
  assert.equal(initialsOf("Nguyễn Thị Ánh Tuyết"), "NT");
});

test("sem letra nenhuma cai no substituto", () => {
  assert.equal(initialsOf("   "), "?");
  assert.equal(initialsOf("", "DP"), "DP");
});
