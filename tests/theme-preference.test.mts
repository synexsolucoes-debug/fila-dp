import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  nextThemePreference, parseResolvedTheme, parseThemePreference, resolveTheme,
  THEME_COOKIE, THEME_SYSTEM_COOKIE, themeLabels,
} from "../lib/theme.ts";

/**
 * Travas do tema claro/escuro.
 *
 * Contraste quem mede é `npm run a11y-check`, contra o produto de pé, nos dois
 * temas. O que está aqui é o que a auditoria não pega: as decisões que, se
 * alguém desfizer, quebram o tema sem quebrar nenhuma tela isoladamente.
 */

const ler = (caminho: string) => readFile(new URL(`../${caminho}`, import.meta.url), "utf8");

/* -------------------------------------------------------------------------- */
/* Vocabulário                                                                */
/* -------------------------------------------------------------------------- */

test("cookie de fora nunca vira classe de CSS inventada", () => {
  /* Cookie é entrada de terceiro: qualquer string chega aqui, inclusive de um
     navegador que guardou o vocabulário de outra versão do produto. Se o valor
     passasse direto, `theme-<lixo>` entraria na casca e o painel abriria sem
     tema nenhum — uma tela sem cor, difícil de reproduzir e fácil de culpar o
     usuário. */
  for (const lixo of ["", "  ", "Dark", "theme-dark", "light;", "../../etc", "system ", undefined, null]) {
    assert.equal(parseThemePreference(lixo as string | undefined), "system",
      `"${String(lixo)}" deveria cair no padrão`);
  }
  for (const bom of ["system", "light", "dark"] as const) {
    assert.equal(parseThemePreference(bom), bom);
  }
});

test("o que o navegador respondeu por último só pode ser claro ou escuro", () => {
  assert.equal(parseResolvedTheme("dark"), "dark");
  assert.equal(parseResolvedTheme("light"), "light");
  // "sistema" não é resposta: é a pergunta. Cair em claro é o erro menos
  // surpreendente, porque claro é a escala que a maquete aprovou.
  assert.equal(parseResolvedTheme("system"), "light");
  assert.equal(parseResolvedTheme(undefined), "light");
});

test("a escala que vai à tela segue a escolha, e só consulta o sistema quando mandada", () => {
  assert.equal(resolveTheme("light", "dark"), "light",
    "escolher claro com o sistema em escuro tem de dar claro");
  assert.equal(resolveTheme("dark", "light"), "dark",
    "escolher escuro com o sistema em claro tem de dar escuro");
  assert.equal(resolveTheme("system", "dark"), "dark");
  assert.equal(resolveTheme("system", "light"), "light");
});

test("o botão percorre os três estados e volta ao começo", () => {
  /* Um botão que cicla e não fecha o ciclo deixa um estado inalcançável. */
  const visitados = new Set<string>();
  let atual: ReturnType<typeof nextThemePreference> = "system";
  for (let i = 0; i < 3; i += 1) { visitados.add(atual); atual = nextThemePreference(atual); }
  assert.deepEqual([...visitados].sort(), ["dark", "light", "system"]);
  assert.equal(atual, "system", "três passos têm de voltar ao ponto de partida");
});

test("todo estado tem rótulo em português, porque ele vai para o leitor de tela", () => {
  for (const estado of ["system", "light", "dark"] as const) {
    assert.match(themeLabels[estado], /^[A-ZÀ-Ú]/u, `${estado} sem rótulo apresentável`);
  }
});

/* -------------------------------------------------------------------------- */
/* Onde o estado mora                                                          */
/* -------------------------------------------------------------------------- */

test("o tema chega resolvido do servidor, e não de um efeito depois da hidratação", async () => {
  /* Esta é a trava central, e o motivo é o mesmo que a rota coringa do painel
     já registra: o que se resolve depois da hidratação pisca. Com o tema, o
     lampejo é a tela inteira trocando de cor a cada carregamento — num painel
     que se abre dezenas de vezes por dia.

     Se alguém trocar o cookie por `localStorage`, o servidor perde a
     informação e o lampejo volta sem nenhum teste de tela quebrar. */
  const page = await ler("app/painel/[[...secao]]/page.tsx");
  assert.match(page, /cookies\(\)/u, "a página precisa ler cookie para saber o tema antes de renderizar");
  assert.match(page, /initialTheme=\{resolveTheme\(/u, "a escala tem de ir resolvida como prop");

  const app = await ler("app/painel/WorkspaceApp.tsx");
  assert.match(app, /useState<ThemePreference>\(initialThemePreference\)/u,
    "o estado inicial tem de vir da prop, não de uma leitura no cliente");
  assert.doesNotMatch(app, /localStorage\.(get|set)Item\(\s*["'`]vinculato-theme/u,
    "a preferência de tema não pode voltar para localStorage: o servidor precisa dela");
});

test("as duas preferências vão para cookie, e com prazo e escopo declarados", async () => {
  const app = await ler("app/painel/WorkspaceApp.tsx");
  for (const cookie of [THEME_COOKIE, THEME_SYSTEM_COOKIE]) {
    const escrita = new RegExp(String.raw`\$\{${cookie === THEME_COOKIE ? "THEME_COOKIE" : "THEME_SYSTEM_COOKIE"}\}=`, "u");
    assert.match(app, escrita, `${cookie} não é gravado em lugar nenhum`);
  }
  // Sem `path=/`, a preferência valeria só no endereço em que foi trocada.
  const gravacoes = app.match(/document\.cookie = `[^`]+`/gu) ?? [];
  assert.ok(gravacoes.length >= 2, "esperava as duas gravações de cookie");
  for (const linha of gravacoes) {
    assert.match(linha, /path=\//u, `cookie sem path=/: ${linha}`);
    assert.match(linha, /max-age=/u, `cookie sem prazo: ${linha}`);
    assert.match(linha, /samesite=lax/u, `cookie sem samesite: ${linha}`);
  }
});

test("o esquema nativo do navegador acompanha o tema, e não fica preso em um", async () => {
  /* `color-scheme` é o que o CSS não alcança: a lista aberta de um `select`, a
     barra de rolagem e o seletor de data são desenhados pelo navegador. Preso
     em "light", o tema escuro abre um calendário branco; preso em "dark", o
     claro abre uma barra de rolagem preta. */
  const app = await ler("app/painel/WorkspaceApp.tsx");
  assert.match(app, /document\.documentElement\.style\.colorScheme = theme;/u,
    "o esquema nativo tem de seguir a variável do tema");
  assert.doesNotMatch(app, /colorScheme = ["'](light|dark)["']/u,
    "colorScheme não pode ser fixado em um tema");
});

test("a casca só ganha theme-dark quando a escala resolvida é escura", async () => {
  const app = await ler("app/painel/WorkspaceApp.tsx");
  assert.match(app, /theme === "dark" \? " theme-dark" : ""/u,
    "a classe do tema escuro tem de derivar da escala resolvida");
});

/* -------------------------------------------------------------------------- */
/* O controle                                                                  */
/* -------------------------------------------------------------------------- */

test("o botão de tema diz em que estado está e para onde vai", async () => {
  /* Um botão que cicla é mudo para quem não vê o ícone mudar: sem dizer o
     estado atual e o próximo, "trocar tema" não informa nem o que está valendo
     agora nem o que o clique vai fazer. */
  const app = await ler("app/painel/WorkspaceApp.tsx");
  const bloco = app.slice(app.indexOf('className="switch-account-button theme-toggle"'));
  assert.ok(bloco, "o botão de tema sumiu do rodapé da barra");
  const rotulo = bloco.slice(0, bloco.indexOf("</button>"));
  assert.match(rotulo, /aria-label=\{`Tema: \$\{themeLabels\[themePreference\]/u,
    "o rótulo tem de nomear o estado atual");
  assert.match(rotulo, /Trocar para \$\{themeLabels\[nextThemePreference\(themePreference\)\]/u,
    "o rótulo tem de nomear o próximo estado");
});

/* -------------------------------------------------------------------------- */
/* A cascata                                                                   */
/* -------------------------------------------------------------------------- */

test("os tokens claros da casca não vencem o tema escuro", async () => {
  /* A casca clara entrou em `interface-refresh.css`, que carrega por último, e
     por ordem venceria as regras escuras de `dashboard-modern.css`. Quem
     desempata é a especificidade: `.dashboard-shell.theme-dark` pesa (0,2,0) e
     `.operational-ui` pesa (0,1,0).
     
     Se alguém subir a casca clara para (0,2,0) — `.dashboard-shell.operational-ui`,
     por exemplo —, ela passa a empatar e a ordem decide a favor do claro: o
     tema escuro morre calado, sem nenhuma tela quebrar. */
  const css = await ler("app/interface-refresh.css");
  const tokens = css.slice(css.indexOf(".operational-ui {"));
  const cabecalho = tokens.slice(0, tokens.indexOf("{"));
  assert.ok(!/\.dashboard-shell/u.test(cabecalho),
    "o bloco de tokens da casca clara não pode subir de especificidade");
  assert.doesNotMatch(css, /\.operational-ui\s*\{[^}]*--ui-bg[^}]*\}\s*\/\*\s*!important/u);
});
