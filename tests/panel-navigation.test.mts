import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §17 e §18: o menu por contexto e a barra superior.
 *
 * O menu tinha treze itens sob um rótulo só — "OPERAÇÃO" —, e Cadastros,
 * Relatórios e Estado das integrações não são operação. Rótulo que não descreve
 * o que está embaixo é pior que rótulo nenhum: ensina a ignorá-lo.
 *
 * Por baixo havia três listas paralelas que ninguém obrigava a concordar —
 * cabeçalho da tela, título curto para o assistente e os treze botões escritos
 * à mão — e um quarto lugar pior que os outros: a ação primária da barra
 * superior aparecia por *negação*. `view !== "registrations" && view !==
 * "auxiliary" && …` seis vezes. Uma tela nova nascia com "Nova demanda" no topo
 * sem ter demanda nenhuma para criar, e só um olho humano notaria.
 */

const source = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
const catalog = source.slice(source.indexOf("const viewCatalog: Record<View, ViewEntry>"), source.indexOf("const navOrder"));
const views = (source.match(/^type View = (.+);$/mu)?.[1] ?? "")
  .split("|").map((part) => part.trim().replace(/"/gu, "")).filter(Boolean);

test("toda tela do painel está no catálogo, com seção declarada", () => {
  assert.ok(views.length >= 13, "o tipo View não foi lido");
  for (const view of views) {
    assert.match(catalog, new RegExp(`\\n  ${view}: \\{`, "u"), `${view} fora do catálogo`);
  }
  // `Record<View, ViewEntry>` já obriga a completude no compilador; esta
  // conferência existe para o caso de o tipo afrouxar.
  const declaradas = catalog.match(/section: "(\w+)"/gu) ?? [];
  assert.equal(declaradas.length, views.length, "toda tela precisa de uma seção");
});

test("as seções do menu têm rótulo honesto e nenhuma fica vazia por construção", () => {
  const sections = source.slice(source.indexOf("const navSections"), source.indexOf("type ViewEntry"));
  for (const [id, label] of [["operacao", "OPERAÇÃO"], ["pessoas", "PESSOAS E CADASTROS"],
    ["financeiro", "FINANCEIRO"], ["dados", "DADOS E ANÁLISE"]]) {
    assert.match(sections, new RegExp(`id: "${id}", label: "${label}"`, "u"));
    assert.match(catalog, new RegExp(`section: "${id}"`, "u"), `a seção ${id} não tem nenhuma tela`);
  }
  // Uma seção pode ficar vazia em tempo de execução — plano sem o módulo,
  // papel sem acesso — e nesse caso ela não é desenhada.
  assert.match(source, /if \(!items\.length\) return null;/u);
});

test("Cadastros e Relatórios deixaram de ser anunciados como operação", () => {
  // O defeito concreto que a §17 aponta.
  const registrations = catalog.slice(catalog.indexOf("  registrations: {"));
  assert.match(registrations.slice(0, 240), /section: "pessoas"/u);
  const indicators = catalog.slice(catalog.indexOf("  indicators: {"));
  assert.match(indicators.slice(0, 240), /section: "dados"/u);
});

test("a ação primária da barra é declarada, nunca deduzida por exclusão", () => {
  // Comentários fora antes de procurar: o texto que explica a decisão cita a
  // cadeia antiga, e casar com ele acusaria o contrário do que se quer.
  const codigo = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  assert.doesNotMatch(codigo, /view !== "registrations"/u,
    "a cadeia de negações é o que fazia uma tela nova nascer com o botão errado");
  assert.match(source, /\{canEdit && primaryAction && <button className="new-demand"/u);

  // Só as telas cujo objeto é a demanda oferecem o botão. As outras têm os
  // próprios comandos: um botão genérico ali criaria dois caminhos para a mesma
  // coisa, ou um caminho para coisa nenhuma.
  const comAcao = [...catalog.matchAll(/\n  (\w+): \{[\s\S]*?\n  \},/gu)]
    .filter(([bloco]) => bloco.includes("primaryAction:"))
    .map(([, nome]) => nome).sort();
  assert.deepEqual(comAcao, ["board", "inbox", "overview", "planner", "processes"]);

  // E o Inbox cria solicitação, não demanda — o rótulo acompanha a ação.
  assert.match(catalog, /primaryAction: \{ label: "Nova solicitação", kind: "inbox" \}/u);
});

test("a visibilidade é decidida num lugar só", () => {
  assert.match(source, /if \(entry\.module && !hasModule\(entry\.module\)\) return false;/u);
  assert.match(source, /return !\(role && entry\.hiddenFor\?\.includes\(role\)\);/u);
  // A comparação de papel estava escrita em sete botões. Sete cópias de uma
  // regra de acesso são sete chances de uma divergir das outras.
  const jsx = source.slice(source.indexOf('<nav aria-label="Navegação do painel">'));
  assert.doesNotMatch(jsx.slice(0, 1400), /role !== "guest"|role !== "observer"/u);
});

test("o menu vira barra inferior sem que os grupos quebrem a grade", async () => {
  // `display: contents` devolve os botões à grade da barra. Sem isso ela
  // posicionaria os quatro grupos e mostraria quatro colunas com os itens
  // empilhados dentro — regressão que nenhum teste de unidade veria.
  const css = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  assert.match(css, /\.sidebar-nav-group \{ display: contents; \}/u);
  assert.match(css, /\.sidebar-nav-group \{ display: flex; flex-direction: column; gap: 4px; \}/u);
});

test("o catálogo é a única fonte do título de tela", () => {
  // Havia `viewContent` e `viewTitles` em paralelo, e o assistente lia o
  // segundo: bastava atualizar um para ele passar a informar a tela errada.
  assert.doesNotMatch(source, /viewTitles|viewContent/u);
  assert.match(source, /<AssistantPanel screen=\{viewCatalog\[view\]\.label\}/u);
});

test("o botão de ajuda abre a ajuda que existe", async () => {
  // Ele respondia com uma frase fixa — "use a busca global ou abra uma demanda"
  // — que é um botão de ajuda que não ajuda: diz o que fazer sem responder à
  // pergunta. O painel do assistente já estava construído para isso, e as
  // instruções dele mandam explicar o caminho e apontar a tela e o botão.
  assert.doesNotMatch(source, /Use a busca global ou abra uma demanda/u);
  assert.match(source, /className="help-button" aria-label="Abrir o assistente"/u);
  assert.match(source, /openSignal=\{assistantSignal\}/u);

  const assistant = await readFile(new URL("../app/painel/features/assistant/AssistantPanel.tsx", import.meta.url), "utf8");
  assert.match(assistant, /if \(openSignal <= 0\) return;/u);
  // Esc continua fechando: a ajuda não pode virar parede entre a pessoa e a tela.
  assert.match(assistant, /event\.key === "Escape"/u);
});
