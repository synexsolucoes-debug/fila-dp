import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_RULE_TRIGGER, RULE_ACTIONS, RULE_TRIGGERS, RULE_TRIGGER_LABELS,
  parseRuleAction, parseRuleTrigger,
} from "../lib/automation-rules.ts";

/**
 * §27: compor automação de verdade.
 *
 * O compositor já existia — gatilho, condição, ação, com prévia. O que faltava
 * era vocabulário: nenhum evento de **processo** chegava ao motor de regras, e
 * nenhuma ação avisava ninguém. E a lista de gatilhos vivia escrita duas vezes,
 * com a rota trocando o desconhecido por `card.created` em silêncio.
 */

/* ── Gatilho ───────────────────────────────────────────────────────────── */

test("os eventos de processo passam a ser gatilho (§27)", () => {
  // "Etapa Documentação concluída → iniciar Registro" é literalmente isto.
  assert.equal(parseRuleTrigger("process.step_advanced"), "process.step_advanced");
  assert.equal(parseRuleTrigger("process.instance_completed"), "process.instance_completed");
});

test("gatilho desconhecido é recusado, e não trocado em silêncio", () => {
  /* Era o defeito: a rota trocava por `card.created`. A regra ficava salva com
     o nome que a pessoa deu e disparava na hora errada, sem erro em lugar
     nenhum — cada lado parecia certo sozinho. */
  for (const raw of ["card.deleted", "", null, undefined, 42, "process.step"]) {
    assert.equal(parseRuleTrigger(raw), null, `${String(raw)} não pode virar gatilho`);
  }
  assert.equal(DEFAULT_RULE_TRIGGER, "card.created", "o padrão continua o de antes, para quem não escolhe");
});

test("todo gatilho tem frase em português", () => {
  // Sem rótulo, a lista mostraria "process.step_advanced" para quem configura.
  for (const trigger of RULE_TRIGGERS) {
    assert.ok(RULE_TRIGGER_LABELS[trigger], `${trigger} sem rótulo`);
    assert.ok(!RULE_TRIGGER_LABELS[trigger].includes("."), `${trigger} mostra o código cru`);
  }
});

/* ── Ação ──────────────────────────────────────────────────────────────── */

test("a ação de avisar quem responde passa a existir (§27)", () => {
  // "Tarefa vencida → notificar responsável": até aqui a regra sabia mover,
  // etiquetar e mexer no prazo, nunca avisar alguém.
  assert.deepEqual(parseRuleAction({ notify: "Documentação vencida" }), { notify: "Documentação vencida" });
});

test("a ação é montada campo a campo, e o que o executor não sabe fazer é recusado", () => {
  /* Guardar o objeto que chegou guardaria uma regra que o motor não executa:
     ela apareceria configurada na tela e nunca faria nada. */
  for (const raw of [null, undefined, "moveTo", 7, {}, { deleteCard: true }, { moveTo: "" }, { notify: "   " }]) {
    assert.equal(parseRuleAction(raw), null, `${JSON.stringify(raw)} não pode virar ação`);
  }
  assert.equal(parseRuleAction({ slaStatus: "explodir" }), null, "status de SLA vem de conjunto fechado");
  assert.deepEqual(parseRuleAction({ slaStatus: "overdue" }), { slaStatus: "overdue" });
});

test("o aviso não carrega marcação nem caractere de controle", () => {
  // Ele vai para a caixa de avisos de uma pessoa; texto cru entra, marcação não.
  const action = parseRuleAction({ notify: "<b>Conferir</b>\n\tagora" });
  assert.deepEqual(action, { notify: "b Conferir /b agora" });
});

test("o aviso tem teto de tamanho", () => {
  const action = parseRuleAction({ notify: "a".repeat(400) }) as { notify: string };
  assert.equal(action.notify.length, 160);
});

/* ── Os dois lados leem a mesma lista ──────────────────────────────────── */

test("a tela oferece exatamente os gatilhos que o servidor aceita", async () => {
  /* Uma tela com um gatilho a mais entrega uma regra que o servidor recusa; com
     um a menos, esconde automação que o motor executa. Os dois lados leem daqui
     — e este teste é o que impede a lista de ser recopiada de novo. */
  const screen = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(screen, /import \{ RULE_TRIGGERS, RULE_TRIGGER_LABELS \} from "@\/lib\/automation-rules"/u);
  assert.match(screen, /RULE_TRIGGERS\.map/u, "o select precisa percorrer a lista, não repeti-la");

  const route = await readFile(new URL("../app/api/catalog/route.ts", import.meta.url), "utf8");
  assert.match(route, /parseRuleTrigger\(body\.trigger\)/u);
  assert.match(route, /parseRuleAction\(body\.action\)/u);
  assert.ok(!/\["card\.created", "card\.moved"/u.test(route),
    "a rota voltou a manter a própria lista de gatilhos");
});

test("a rota recusa em vez de aceitar calada", async () => {
  const route = await readFile(new URL("../app/api/catalog/route.ts", import.meta.url), "utf8");
  assert.match(route, /Escolha um gatilho que o produto reconheça/u);
  assert.match(route, /Escolha uma ação que o produto saiba executar/u);
});

/* ── O motor ───────────────────────────────────────────────────────────── */

test("avançar etapa passa a acordar as automações", async () => {
  /* O motor de regras existia e nenhum evento de processo o alcançava: mover
     etapa mudava a demanda sem que nenhuma regra soubesse. */
  const route = await readFile(
    new URL("../app/api/cards/[id]/process/route.ts", import.meta.url), "utf8");
  assert.match(route, /runAutomations\(workspace\.id, instance\.boardId, instance\.id, eventName/u);
  // Depois do lote: a transição precisa estar gravada antes de qualquer regra
  // reagir a ela.
  assert.ok(route.indexOf("await d1.batch(") < route.indexOf("await runAutomations("),
    "a automação não pode rodar antes de a etapa estar gravada");
});

test("o executor sabe notificar, e a notificação é idempotente", async () => {
  const db = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.match(db, /INSERT INTO fdp_notifications/u);
  assert.match(db, /ON CONFLICT \(user_id, event_key\) DO NOTHING/u,
    "sem isso, reexecutar a regra encheria a caixa de avisos da pessoa (§82)");
  assert.match(db, /FROM fdp_card_assignees/u,
    "quem é avisado é quem responde pela demanda, não quem disparou o evento");
});

test("toda ação declarada tem tratamento no executor", async () => {
  const db = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  const executor = db.slice(db.indexOf("export async function runAutomations"));
  for (const action of RULE_ACTIONS) {
    assert.match(executor, new RegExp(`action\\.${action}`, "u"),
      `${action} é oferecido e o executor não sabe executar`);
  }
});
