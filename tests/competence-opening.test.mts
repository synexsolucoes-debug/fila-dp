import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { competenceWindow, nextFreeCompetence, shiftCompetence } from "../app/painel/features/shared/competence-cycle.ts";

/**
 * A abertura de competência existia em toda parte, menos onde se clica.
 *
 * O servidor aceitava `POST /api/operations/competences`, o diálogo "Abrir
 * competência" estava escrito com os quatro campos, e mesmo assim não havia
 * como abrir novembro em outubro nem recuperar um mês antigo que ninguém
 * abriu na época:
 *
 * - o seletor de competência só listava ciclos **já existentes**, então nenhum
 *   mês livre era alcançável;
 * - o botão só aparecia quando o mês em tela não tinha ciclo — aberto o mês
 *   corrente, ele sumia da tela e não voltava mais;
 * - o campo do diálogo vinha preenchido com o mês em tela, que era justamente
 *   o único valor que o servidor recusa com 409.
 *
 * Os três juntos fechavam o circuito. Este arquivo guarda cada um deles.
 */

const operacao = await readFile(new URL("../app/painel/features/operations/OperationsView.tsx", import.meta.url), "utf8");
const dialogos = await readFile(new URL("../app/painel/features/operations/OperationDialogs.tsx", import.meta.url), "utf8");
const pagamentos = await readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8");

test("a janela de competências oferece meses que ainda não têm ciclo", () => {
  const escolhas = competenceWindow(["2026-09"], { reference: "2026-09", back: 2, forward: 2 });
  assert.deepEqual(escolhas.map((item) => item.competence), ["2026-11", "2026-10", "2026-09", "2026-08", "2026-07"]);
  assert.deepEqual(escolhas.filter((item) => item.open).map((item) => item.competence), ["2026-09"],
    "só o mês com ciclo pode aparecer como aberto");
});

test("a janela alcança meses antigos que ficaram para trás", () => {
  const escolhas = competenceWindow([], { reference: "2026-09" });
  assert.ok(escolhas.some((item) => item.competence === "2025-09"), "doze meses para trás");
  assert.ok(escolhas.some((item) => item.competence === "2026-12"), "três meses para a frente");
});

test("um ciclo fora da janela continua listado", () => {
  // Competência apurada há dois anos: some do intervalo padrão, mas existe no
  // banco e a tela precisa conseguir voltar nela.
  const escolhas = competenceWindow(["2024-03"], { reference: "2026-09" });
  const antiga = escolhas.find((item) => item.competence === "2024-03");
  assert.ok(antiga?.open, "o ciclo antigo sumiu do seletor");
  const meses = escolhas.map((item) => item.competence);
  assert.deepEqual(meses, [...meses].sort().reverse(), "a lista sai da mais recente para a mais antiga");
  assert.equal(meses.at(-1), "2024-03", "o ciclo antigo fica no fim, abaixo da janela");
});

test("a janela ignora competência malformada", () => {
  const escolhas = competenceWindow(["2026-13", "", "abril"], { reference: "2026-09", back: 1, forward: 0 });
  assert.deepEqual(escolhas.map((item) => item.competence), ["2026-09", "2026-08"]);
});

test("o deslocamento de mês vira o ano", () => {
  assert.equal(shiftCompetence("2026-11", 2), "2027-01");
  assert.equal(shiftCompetence("2026-01", -1), "2025-12");
  assert.equal(shiftCompetence("2026-13", 1), "2026-13", "mês inválido volta como veio");
});

test("o diálogo sugere um mês livre, nunca o que o servidor recusa", () => {
  assert.equal(nextFreeCompetence(["2026-09"], "2026-09"), "2026-10");
  assert.equal(nextFreeCompetence(["2026-09", "2026-10"], "2026-09"), "2026-11");
  assert.equal(nextFreeCompetence([], "2026-07"), "2026-07", "mês livre é mantido");
});

test("o seletor da Operação DP é alimentado pela janela, não pelos ciclos", () => {
  assert.match(operacao, /competenceWindow\(data\?\.cycles\.map\(\(item\) => item\.competence\) \?\? \[\], \{ selected: competence \}\)/u);
  assert.doesNotMatch(operacao, /data\?\.cycles\.filter\(\(item\) => item\.competence !== competence\)\.map/u,
    "o seletor voltou a listar só os ciclos existentes");
  assert.match(operacao, /item\.open \? "" : " · não aberta"/u, "o mês sem ciclo precisa se identificar");
});

test("o botão de abrir competência segue a permissão, não o estado do ciclo", () => {
  const barra = operacao.slice(operacao.indexOf("<div className={styles.commandActions}>"), operacao.indexOf("</div>", operacao.indexOf("<div className={styles.commandActions}>")));
  assert.match(barra, /permissions\.manageCompetences && <button[^>]*onClick=\{\(\) => setEditor\(\{ kind: "competence" \}\)\}/u,
    "a abertura precisa aparecer mesmo com ciclo em tela");
  assert.match(barra, /cycle && next && data\?\.permissions\.transitionCompetences/u,
    "o avanço continua dependendo de haver ciclo e próxima etapa");
});

test("o estado vazio do ciclo oferece a ação que ele descreve", () => {
  assert.match(operacao, /onOpen=\{data\?\.permissions\.manageCompetences \? \(\) => setEditor\(\{ kind: "competence" \}\) : undefined\}/u);
  assert.match(operacao, /\{onOpen && <button className=\{styles\.primaryButton\}/u,
    "o aviso 'ainda não foi aberta' sem botão é um beco sem saída");
});

test("a recarga usa a competência recém-aberta, não a que estava em tela", () => {
  // `setCompetence` é assíncrono: a closure que chama a recarga ainda enxerga
  // o mês antigo e traria de volta a tela que o usuário acabou de deixar.
  assert.match(operacao, /async function refreshAfterMutation\(selectedCompetence = competence\)/u);
  assert.match(operacao, /setCompetence\(aberta\);\s*\n\s*setEditor\(null\); await refreshAfterMutation\(aberta\);/u);
});

test("o diálogo avisa antes de o servidor recusar a competência repetida", () => {
  assert.match(dialogos, /nextFreeCompetence\(openCompetences, competence\)/u);
  assert.match(dialogos, /const repetida = openCompetences\.includes\(escolhida\)/u);
  assert.match(dialogos, /Esta competência já tem ciclo nesta empresa/u);
  assert.match(operacao, /openCompetences=\{openCompetences\}/u, "o diálogo precisa saber o que já existe");
});

test("Pagamentos PJ alcança o mês que ainda não foi aberto", () => {
  // A tela avisa "abra-a em Operação DP", e o aviso nunca aparecia para um mês
  // sem ciclo: não havia como selecionar esse mês.
  assert.match(pagamentos, /competenceWindow\(cycles\.map\(\(item\) => item\.competence\), \{ selected: competence \}\)/u);
  assert.match(pagamentos, /ainda não foi aberta para esta empresa/u);
});
