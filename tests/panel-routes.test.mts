import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  defaultPanelLocation, demandPath, panelPath, panelRoutes, panelViews,
  parsePanelPath, settingsSections,
} from "../lib/panel-routes.ts";

/* O painel inteiro era estado de React em `/painel`. Não dava para mandar o
   link de uma demanda, voltar saía do produto e F5 perdia o contexto. Estes
   testes protegem a tradução estado ⇄ endereço, que é onde um erro de
   mapeamento só apareceria em produção. */

test("cada visão tem um endereço, e nenhum se repete", () => {
  const paths = panelViews.map((view) => panelPath({ view }));
  assert.equal(new Set(paths).size, paths.length, "duas visões dividindo o mesmo endereço");
  for (const path of paths) assert.ok(path.startsWith("/painel"), `endereço fora do painel: ${path}`);
});

test("ida e volta preserva a visão", () => {
  for (const view of panelViews) {
    const path = panelPath({ view });
    assert.equal(parsePanelPath(path).view, view, `${view} não sobrevive à ida e volta em ${path}`);
  }
});

test("o caminho mais longo vence o mais curto", () => {
  // Sem ordenar por tamanho, `pj/fechamentos` casaria com `pj` e a pessoa
  // cairia na tela errada — o tipo de erro que só aparece com o link na mão.
  assert.equal(parsePanelPath("/painel/pj").view, "contractorPayments");
  assert.equal(parsePanelPath("/painel/pj/fechamentos").view, "contractorClosings");
  assert.equal(parsePanelPath("/painel/pj/caju").view, "contractorCaju");
});

test("a demanda tem endereço próprio — é o link que se manda para o colega", () => {
  assert.equal(demandPath("card-1"), "/painel/demandas/card-1");
  const parsed = parsePanelPath("/painel/demandas/card-1");
  assert.equal(parsed.view, "board");
  assert.equal(parsed.recordId, "card-1");
});

test("identificador com caractere especial sobrevive à viagem", () => {
  const path = demandPath("a/b c");
  const parsed = parsePanelPath(path);
  assert.equal(parsed.recordId.startsWith("a"), true);
  assert.ok(!path.includes(" "), "espaço cru no endereço quebra ao colar no chat");
});

test("o registro só aparece na visão que sabe abri-lo", () => {
  // Um identificador pendurado numa visão que não abre registro seria um
  // endereço que promete algo e não entrega.
  assert.equal(panelPath({ view: "timeTracking", recordId: "x" }), "/painel/ponto");
  assert.equal(parsePanelPath("/painel/ponto/x").recordId, "");
});

test("o filtro de empresa vai na URL e volta dela", () => {
  const path = panelPath({ view: "board", companyId: "empresa-1" });
  assert.equal(path, "/painel/demandas?empresa=empresa-1");
  assert.equal(parsePanelPath("/painel/demandas", "?empresa=empresa-1").companyId, "empresa-1");
  assert.equal(parsePanelPath("/painel/demandas", "empresa=empresa-1").companyId, "empresa-1");
});

test("configurações são endereçáveis, uma por seção (§46)", () => {
  const paths = settingsSections.map((settings) => panelPath({ settings }));
  assert.equal(new Set(paths).size, paths.length);
  for (const settings of settingsSections) {
    const parsed = parsePanelPath(panelPath({ settings }));
    assert.equal(parsed.settings, settings, `a seção ${settings} não sobrevive ao endereço`);
  }
  assert.equal(panelPath({ settings: "security" }), "/painel/configuracoes/seguranca");
});

test("endereço desconhecido abre a visão geral em vez de punir quem clicou", () => {
  // Link antigo que alguém mandou meses atrás não merece um 404.
  assert.deepEqual(parsePanelPath("/painel/inventada"), defaultPanelLocation);
  assert.deepEqual(parsePanelPath("/painel"), defaultPanelLocation);
  assert.deepEqual(parsePanelPath("/"), defaultPanelLocation);
  assert.deepEqual(parsePanelPath(""), defaultPanelLocation);
});

test("a configuração desconhecida cai na primeira seção, não em tela em branco", () => {
  assert.equal(parsePanelPath("/painel/configuracoes/inventada").settings, "general");
  assert.equal(parsePanelPath("/painel/configuracoes").settings, "general");
});

test("nenhuma decisão de acesso mora no mapeamento de rotas", async () => {
  const source = await readFile(new URL("../lib/panel-routes.ts", import.meta.url), "utf8");
  for (const forbidden of [/capability/iu, /hasCapability/u, /role/iu, /permission/iu]) {
    assert.ok(!forbidden.test(source.replace(/\/\*[\s\S]*?\*\//gu, "")),
      `o mapeamento passou a decidir acesso: ${forbidden}`);
  }
});

test("o painel tem uma rota coringa — senão o F5 devolve 404", async () => {
  const page = await readFile(new URL("../app/painel/[[...secao]]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /parsePanelPath/u, "a rota precisa traduzir o endereço em estado");
  assert.match(page, /requireChatGPTUser/u, "o endereço é um pedido, não uma permissão");
  assert.match(page, /initialLocation/u, "o estado inicial vem do servidor, não de um efeito");
});

test("o painel sincroniza o endereço nas duas direções", async () => {
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /window\.history\.pushState/u, "sem push, copiar o link não leva ao mesmo lugar");
  assert.match(app, /window\.history\.replaceState/u, "o primeiro render não empilha histórico");
  assert.match(app, /addEventListener\("popstate"/u, "sem popstate, voltar sai do produto");
});

test("configurações têm porta na navegação, e não só atrás do avatar (§46)", async () => {
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  const sidebar = app.slice(app.indexOf("sidebar-account-actions"), app.indexOf("</aside>"));
  assert.match(sidebar, /openWorkspaceSettings/u,
    "quem procura configurar o grupo olha o menu, não a foto");
  assert.match(sidebar, /aria-label="Abrir configurações"/u);
});

test("a lista de rotas prometidas cobre visões e configurações", () => {
  const routes = panelRoutes();
  assert.equal(routes.length, panelViews.length + settingsSections.length);
  assert.ok(routes.includes("/painel/demandas"));
  assert.ok(routes.includes("/painel/configuracoes/seguranca"));
});

test("a lista de telas do painel tem uma fonte só, e as duas cópias não podem divergir", async () => {
  /* `View`, em WorkspaceApp, é uma união escrita à mão que repete `panelViews`.
     Descobri isso acrescentando uma tela: registrei em `panelViews` e NADA
     quebrou na outra — nem compilação, nem teste. Uma tela em só uma das listas
     falha em silêncio: some do menu, ou perde endereço, sem erro nenhum.

     Enquanto as duas existirem, esta guarda é o que as mantém iguais. */
  const [rotas, app] = await Promise.all([
    readFile(new URL("../lib/panel-routes.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);

  const bloco = rotas.slice(rotas.indexOf("export const panelViews = ["), rotas.indexOf("] as const;"));
  const daRota = new Set([...bloco.matchAll(/"([a-zA-Z]+)"/gu)].map((m) => m[1]));

  const uniao = app.slice(app.indexOf("type View ="), app.indexOf(";", app.indexOf("type View =")));
  const daTela = new Set([...uniao.matchAll(/"([a-zA-Z]+)"/gu)].map((m) => m[1]));

  const soNaRota = [...daRota].filter((id) => !daTela.has(id));
  const soNaTela = [...daTela].filter((id) => !daRota.has(id));

  assert.deepEqual(soNaRota, [],
    "tela com endereço e sem entrada em `View`: o painel não sabe renderizá-la");
  assert.deepEqual(soNaTela, [],
    "tela em `View` e sem endereço: ninguém consegue abri-la por link");
});
