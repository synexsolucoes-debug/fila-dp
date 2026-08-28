import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Cancelar uma demanda (spec: Ações da demanda).
 *
 * Cancelar não é concluir e não é arquivar. Concluir diz que o trabalho foi
 * entregue; arquivar tira da vista sem dizer por quê. Estes testes protegem as
 * três decisões que sustentam a diferença: cancelada sai da fila, não conta
 * como entrega, e sempre diz o motivo.
 */

const migration = await readFile(
  new URL("../drizzle/postgres/0071_card_cancellation.sql", import.meta.url), "utf8");
const rota = await readFile(
  new URL("../app/api/cards/[id]/cancel/route.ts", import.meta.url), "utf8");

test("cancelada sai da fila: cancelled_at exige closed_at", async () => {
  /* Cancelar sem fechar deixaria a demanda para sempre na fila de alguém — as
     sete consultas de "em aberto" leem `closed_at IS NULL`. */
  assert.match(migration, /CONSTRAINT "fdp_cards_cancelled_is_closed_check"\s*\n?\s*CHECK \("cancelled_at" IS NULL OR "closed_at" IS NOT NULL\)/u);
  assert.match(rota, /SET cancelled_at = CURRENT_TIMESTAMP, closed_at = CURRENT_TIMESTAMP/u,
    "a rota precisa preencher as duas, senão a restrição recusa e o cancelamento nunca funciona");
});

test("cancelamento sem motivo é recusado no banco, não só na rota", async () => {
  /* A rota valida, mas uma rota nova amanhã poderia esquecer. A restrição é o
     que garante que nenhum caminho grave cancelamento mudo. */
  assert.match(migration, /CONSTRAINT "fdp_cards_cancellation_check"/u);
  assert.match(migration, /length\(btrim\("cancellation_reason"\)\) > 0/u,
    "motivo só com espaços precisa ser recusado, senão a obrigatoriedade é decorativa");
  assert.match(migration, /"cancelled_at" IS NULL AND "cancellation_reason" = ''/u,
    "motivo sem cancelamento também é estado que mente");
});

test("cancelada não conta como trabalho entregue", async () => {
  /* Uma admissão que não vai acontecer contada como concluída infla a
     produtividade com trabalho que ninguém fez. */
  const usage = await readFile(
    new URL("../app/api/processes/[id]/usage/route.ts", import.meta.url), "utf8");
  assert.match(usage, /FILTER \(WHERE c\.closed_at IS NOT NULL AND c\.cancelled_at IS NULL\)::int AS completed/u);
  assert.match(usage, /FILTER \(WHERE c\.closed_at IS NOT NULL AND c\.cancelled_at IS NULL\) AS average_hours/u,
    "o tempo médio de conclusão não pode incluir o que foi cancelado");

  const work = await readFile(new URL("../lib/work-items.ts", import.meta.url), "utf8");
  assert.match(work, /WHEN c\.cancelled_at IS NOT NULL THEN 'cancelled'/u);
  assert.ok(work.indexOf("cancelled_at IS NOT NULL THEN 'cancelled'")
    < work.indexOf("closed_at IS NOT NULL THEN 'closed'"),
    "o CASE precisa testar cancelada antes de fechada, senão cancelada aparece como concluída");
});

test("demanda já encerrada não é cancelada por cima", async () => {
  /* Sobrescrever a conclusão de alguém em silêncio perderia o desfecho
     original sem que ninguém percebesse. */
  assert.match(rota, /AND closed_at IS NULL`\)/u);
  assert.match(rota, /já encerrada/u,
    "a mensagem precisa dizer por que recusou, não só que não achou");
});

test("o cancelamento é registrado com o motivo no histórico", async () => {
  assert.match(rota, /recordActivity\(workspace\.id, id, auth\.user\.email, "card\.cancelled", \{ reason \}\)/u);
});

test("cancelar exige a mesma permissão de escrever demanda, e o recorte por empresa", async () => {
  assert.match(rota, /requireCapability\(workspace, "cards\.write"\)/u);
  assert.match(rota, /requireCardCompanyAccess\(d1, workspace\.id, user\.id, workspace\.role, id\)/u,
    "sem isto, alguém cancelaria demanda de empresa fora do seu alcance");
  assert.match(rota, /workspace_id = \? AND id = \?/u,
    "o UPDATE precisa do workspace no WHERE, não só o id");
});

test("desistir do diálogo não vira erro, mas motivo em branco vira aviso", async () => {
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /if \(reason === null\) return;/u,
    "fechar o diálogo é desistência, não erro");
  assert.match(app, /if \(!reason\.trim\(\)\) \{ setToast\("Cancelamento precisa de um motivo\."\); return; \}/u);
});

test("o botão de cancelar some quando a demanda já está encerrada", async () => {
  /* Oferecer uma ação que o servidor vai recusar é prometer o que não se
     cumpre — o mesmo motivo pelo qual rascunho não ganha "Iniciar processo". */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /!selectedCard\.archived && !selectedCard\.closedAt && <button type="button" className="danger-link" onClick=\{cancelCard\}>Cancelar demanda<\/button>/u);
});
