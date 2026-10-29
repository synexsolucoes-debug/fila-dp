import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractMentions, mentionMatchesName, mentionWarning, resolveMentions, type MentionCandidate } from "../lib/comment-mentions.ts";

/**
 * Menção em comentário (§18 de `docs/engenharia-reversa-trello.md`).
 *
 * A rota casava `@texto` com `lower(name) LIKE '%texto%'`: `@ana` avisava
 * Mariana, Juliana e Luciana. A menção agora casa por nome inteiro, e
 * ambiguidade não avisa ninguém.
 */

const equipe: MentionCandidate[] = [
  { userId: "ana", name: "Ana Souza", canSeeCard: true },
  { userId: "ana-paula", name: "Ana Paula Lima", canSeeCard: true },
  { userId: "mariana", name: "Mariana Costa", canSeeCard: true },
  { userId: "juliana", name: "Juliana Reis", canSeeCard: true },
  { userId: "joao", name: "João Pereira", canSeeCard: true },
  { userId: "bruno", name: "Bruno Alves", canSeeCard: false },
  { userId: "autor", name: "Carla Mendes", canSeeCard: true },
];

test("@ana não alcança Mariana nem Juliana — o defeito do LIKE", () => {
  assert.equal(mentionMatchesName("ana", "Mariana Costa"), false);
  assert.equal(mentionMatchesName("ana", "Juliana Reis"), false);
  assert.equal(mentionMatchesName("ana", "Ana Souza"), true);
});

test("primeiro nome repetido é ambíguo e ninguém é avisado", () => {
  const result = resolveMentions("@ana pode conferir?", equipe, "autor");
  assert.deepEqual(result.userIds, []);
  assert.deepEqual(result.ambiguous, ["ana"]);
});

test("nome composto desfaz a ambiguidade, com ponto, traço, sublinhado ou colado", () => {
  for (const forma of ["@ana.paula", "@ana-paula", "@ana_paula", "@anapaula", "@Ana.Paula"]) {
    assert.deepEqual(resolveMentions(`${forma} confere`, equipe, "autor").userIds, ["ana-paula"], forma);
  }
  assert.deepEqual(resolveMentions("@ana.souza", equipe, "autor").userIds, ["ana"]);
});

test("acento e caixa não importam", () => {
  assert.deepEqual(resolveMentions("@joao e @JOÃO", equipe, "autor").userIds, ["joao"]);
});

test("sublinhado não é curinga", () => {
  const result = resolveMentions("@a_a", equipe, "autor");
  assert.deepEqual(result.userIds, []);
  assert.deepEqual(result.unknown, ["a_a"]);
});

test("trecho do meio do nome não casa", () => {
  assert.equal(mentionMatchesName("souza", "Ana Souza"), false);
  assert.equal(mentionMatchesName("paula", "Ana Paula Lima"), false);
  assert.equal(mentionMatchesName("anap", "Ana Paula Lima"), false);
});

test("quem não tem acesso à empresa da demanda não é avisado", () => {
  const result = resolveMentions("@bruno veja", equipe, "autor");
  assert.deepEqual(result.userIds, []);
  assert.deepEqual(result.withoutAccess, ["bruno"]);
});

test("o autor se mencionando não vira aviso nem desconhecido", () => {
  const result = resolveMentions("@carla anotado", equipe, "autor");
  assert.deepEqual(result, { userIds: [], ambiguous: [], unknown: [], withoutAccess: [] });
});

test("e-mail no texto não é menção", () => {
  assert.deepEqual(extractMentions("mandei para rh@empresa.com.br"), []);
  assert.deepEqual(extractMentions("(@joao) e @joao."), ["joao"]);
});

test("o aviso diz por que ninguém foi avisado, e some quando tudo casou", () => {
  assert.equal(mentionWarning({ ambiguous: [], unknown: [], withoutAccess: [] }), "");
  const texto = mentionWarning(resolveMentions("@ana @fulano @bruno", equipe, "autor"));
  assert.match(texto, /@ana combina com mais de uma pessoa/u);
  assert.match(texto, /@fulano não é ninguém/u);
  assert.match(texto, /@bruno não tem acesso/u);
});

test("a rota de comentários não volta a procurar por LIKE", async () => {
  const route = await readFile(new URL("../app/api/cards/[id]/comments/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /LIKE/u);
  assert.match(route, /resolveMentions\(/u);
});
