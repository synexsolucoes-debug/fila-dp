import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

/**
 * Travas do shell, do tema e do movimento.
 *
 * Estes testes não medem contraste — quem mede é `npm run a11y-check`, contra o
 * app rodando de verdade, nos dois temas. O que está aqui é o que a auditoria
 * não pega: as decisões estruturais que, se alguém desfizer, fazem os mesmos
 * defeitos voltarem sem ninguém perceber.
 */

const lerCss = (caminho: string) => readFile(new URL(`../${caminho}`, import.meta.url), "utf8");

/* -------------------------------------------------------------------------- */
/* Layout do shell                                                            */
/* -------------------------------------------------------------------------- */

test("o shell não volta a ser contêiner de rolagem por overflow-x", async () => {
  const css = await lerCss("app/access.css");
  // `overflow-x: hidden` no shell faz dele um contêiner de rolagem e anula o
  // `position: sticky` de quem está dentro. Foi assim que a barra lateral subiu
  // junto com a página e deixou os últimos itens do menu sobre fundo claro.
  const blocoShell = css.slice(css.indexOf(".dashboard-shell {", css.indexOf("--ui-bg: #f3f5f4")));
  const ateFechar = blocoShell.slice(0, blocoShell.indexOf("}"));
  assert.doesNotMatch(ateFechar, /overflow-x:\s*hidden/u,
    "o recorte horizontal precisa vir do shell travado na viewport, não de overflow-x");
});

test("no desktop o shell trava na viewport e quem rola é o conteúdo", async () => {
  const css = await lerCss("app/dashboard-modern.css");
  const bloco = css.slice(css.indexOf("@media (min-width: 761px)"));
  assert.match(bloco, /\.dashboard-shell \{[^}]*height: 100dvh/u, "o shell precisa ter a altura da janela");
  assert.match(bloco, /\.dashboard-shell \{[^}]*overflow: hidden/u, "o recorte fica no shell");
  assert.match(bloco, /\.dashboard-content \{[^}]*overflow-y: auto/u, "quem rola é a coluna de conteúdo");
  // A barra precisa ocupar a coluna inteira: com `100vh` dentro de uma linha
  // mais alta, o fundo escuro terminava no meio e o menu ficava ilegível.
  assert.match(bloco, /\.dashboard-sidebar \{[^}]*height: 100%/u);
});

test("a navegação rola dentro da barra, sem levar marca e conta junto", async () => {
  const css = await lerCss("app/dashboard-modern.css");
  const bloco = css.slice(css.indexOf("@media (min-width: 761px)"));
  assert.match(bloco, /\.dashboard-sidebar nav \{[^}]*overflow-y: auto/u,
    "com todos os módulos liberados a navegação passa da altura da janela");
  assert.match(bloco, /\.dashboard-sidebar > :not\(nav\) \{[^}]*flex: 0 0 auto/u,
    "marca e conta ficam ancoradas");
});

test("o layout de celular continua rolando pelo documento", async () => {
  const css = await lerCss("app/dashboard-modern.css");
  const bloco = css.slice(css.indexOf("@media (min-width: 761px)"));
  // A trava de viewport vale do tablet para cima. Abaixo disso o layout é uma
  // barra superior com navegação fixa embaixo, que depende da rolagem normal.
  assert.ok(!/@media \(max-width: 760px\)/u.test(bloco.slice(0, bloco.indexOf("}\n}"))),
    "a regra não pode vazar para o celular");
});

/* -------------------------------------------------------------------------- */
/* Tokens de tema                                                             */
/* -------------------------------------------------------------------------- */

test("o destaque tem três papéis separados, e os três viram com o tema", async () => {
  const css = await lerCss("app/dashboard-modern.css");
  for (const token of ["--ui-accent", "--ui-accent-text", "--ui-on-accent"]) {
    assert.ok(css.includes(`${token}:`), `falta ${token}`);
    // Definido nos dois temas: um token que só existe no claro é o próprio
    // defeito que estamos travando.
    const ocorrencias = css.split(`${token}:`).length - 1;
    assert.ok(ocorrencias >= 2, `${token} precisa de valor no claro e no escuro`);
  }
});

test("nenhum módulo volta a fixar a própria cor de destaque", async () => {
  // Cada módulo declarava a sua (`--saas-indigo: #3159b7`), fixa para o tema
  // claro. No escuro a mesma cor servia de texto sobre superfície escura e de
  // preenchimento sob texto branco, e falhava nos dois papéis.
  const modulos = ["saas", "payments", "time", "integrations", "auxiliary", "operations", "access", "registrations"];
  for (const modulo of modulos) {
    const css = await lerCss(`app/painel/features/${modulo}/${modulo}.module.css`);
    const declaracao = css.match(/--[a-z]+-(?:accent|indigo|mint|brand):\s*([^;]+);/u);
    assert.ok(declaracao, `${modulo}: não achei a cor de destaque`);
    assert.match(declaracao![1], /var\(--ui-accent/u,
      `${modulo} fixou a própria cor de destaque (${declaracao![1].trim()}) — precisa derivar de --ui-accent`);
  }
});

test("preenchimento de destaque não usa branco fixo como texto", async () => {
  // Branco sobre o azul vivo do tema escuro dá 2.26:1.
  const modulos = ["saas", "payments", "time", "integrations", "auxiliary", "operations", "access", "registrations"];
  for (const modulo of modulos) {
    const css = await lerCss(`app/painel/features/${modulo}/${modulo}.module.css`);
    const linhas = css.split("\n").filter((linha) =>
      /background: var\(--[a-z]+-(?:accent|indigo|mint|brand)\)/u.test(linha) && /color: #fff/u.test(linha));
    assert.equal(linhas.length, 0,
      `${modulo}: preenchimento de destaque com branco fixo → ${linhas[0]?.trim().slice(0, 90)}`);
  }
});

test("os estados de selo têm par de texto e fundo nos dois temas", async () => {
  const css = await lerCss("app/dashboard-modern.css");
  for (const estado of ["neutral", "ok", "warn", "danger"]) {
    for (const papel of ["text", "bg"]) {
      const token = `--ui-state-${estado}-${papel}`;
      assert.ok((css.split(`${token}:`).length - 1) >= 2,
        `${token} precisa existir no claro e no escuro`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Movimento                                                                  */
/* -------------------------------------------------------------------------- */

test("as animações só mexem em transform e opacity", async () => {
  const css = await lerCss("app/dashboard-modern.css");
  const nossos = ["viewEnter", "modalIn", "backdropIn", "navMark", "workingPulse"];
  for (const nome of nossos) {
    const inicio = css.indexOf(`@keyframes ${nome}`);
    assert.ok(inicio > 0, `falta o @keyframes ${nome}`);
    const corpo = css.slice(inicio, css.indexOf("\n}", inicio));
    const propriedades = [...corpo.matchAll(/^\s*([a-z-]+):/gmu)].map((m) => m[1]);
    for (const prop of propriedades) {
      // Animar height/top/width obriga o navegador a recalcular layout a cada
      // quadro; em lista grande isso trava visivelmente.
      assert.ok(["transform", "opacity"].includes(prop),
        `${nome} anima "${prop}", que custa layout`);
    }
  }
});

test("quem pede menos movimento recebe menos movimento", async () => {
  const css = await lerCss("app/dashboard-modern.css");
  const bloco = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(bloco, /animation: none/u);
  // O bloco global do globals.css só zerava `transition-duration`; animação
  // continuava rodando. Estas precisam ser desligadas explicitamente.
  for (const alvo of [".view-transition", ".workspace-modal", ".workspace-modal-backdrop"]) {
    assert.ok(bloco.includes(alvo), `falta desligar a animação de ${alvo}`);
  }
});

test("as animações de janela miram classes que existem no código", async () => {
  // Uma regra apontada para uma classe inexistente é regra morta: passa em
  // revisão, não anima nada e ninguém descobre.
  const css = await lerCss("app/dashboard-modern.css");
  const alvos = [...css.matchAll(/^\.(workspace-modal|card-modal|inbox-modal|archive-modal|confirmation-modal|demand-detail-modal|workspace-settings-modal|workspace-modal-backdrop),?$/gmu)]
    .map((m) => m[1]);
  assert.ok(alvos.length > 0, "não achei as regras de animação de janela");

  const arquivos = await readdir(new URL("../app/painel", import.meta.url));
  const fontes = await Promise.all(arquivos.filter((nome) => nome.endsWith(".tsx"))
    .map((nome) => readFile(new URL(`../app/painel/${nome}`, import.meta.url), "utf8")));
  const tudo = fontes.join("\n");
  for (const alvo of new Set(alvos)) {
    assert.ok(tudo.includes(alvo), `nenhum componente usa a classe "${alvo}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* Exclusão de workspace                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A interface de exclusão nasceu neste ramo em `PlatformDetail.tsx` e, em
 * paralelo, a modularização do console global entregou a mesma coisa melhor —
 * com armadilha de foco e restauração do foco anterior, que a minha não tinha.
 * A duplicata foi descartada; estes testes seguem o recurso para onde ele foi,
 * porque a cobertura é do comportamento, não do arquivo.
 */

test("a exclusão definitiva tem interface, e ela reflete as travas do servidor", async () => {
  const tela = await readFile(new URL("../app/plataforma/features/ClientsFeature.tsx", import.meta.url), "utf8");
  // A rota existia desde antes; o que faltava era alguém chamá-la.
  assert.match(tela, /\/delete/u);
  assert.match(tela, /reasonMinLength: 10/u);
  assert.match(tela, /typedConfirmation: text\(workspace\.slug\)/u,
    "o slug digitado por extenso é a trava que impede o clique cair no grupo errado");
  // Só grupo fora de operação: sem esta porta, um clique apaga cliente ativo.
  assert.match(tela, /\["archived", "canceled"\]\.includes\(status\)/u);
  assert.match(tela, /irreversível/u, "a tela precisa dizer que não tem volta");
  // O botão fica sempre visível — esconder virava "não acho a opção de excluir" —
  // mas desabilitado enquanto o cliente está em operação, com a dica do que
  // falta. A trava real continua no backend (WORKSPACE_NOT_ARCHIVED).
  assert.match(tela, /disabled=\{!canPurge\}/u, "o botão de excluir fica visível, porém desabilitado fora de operação");
  assert.match(tela, /Arquive ou cancele o cliente antes de excluir/u, "a dica precisa dizer o que fazer para liberar");
  assert.doesNotMatch(tela, /\{\["archived", "canceled"\]\.includes\(status\) && <div className=\{styles\.dangerZone\}/u,
    "a zona de exclusão não pode voltar a sumir por completo — só o botão é gated");
});

test("o diálogo de ação prende o foco e o devolve ao fechar", async () => {
  const core = await readFile(new URL("../app/plataforma/features/core.tsx", import.meta.url), "utf8");
  assert.match(core, /event\.key === "Escape" && !busy/u, "Esc não pode escapar no meio de uma ação enviada");
  assert.match(core, /previous\?\.focus\(\)/u, "o foco volta para onde estava");
  assert.match(core, /event\.key !== "Tab"/u, "o Tab precisa circular dentro do diálogo");
  assert.match(core, /role="dialog" aria-modal="true"/u);
});

test("a confirmação só libera quando todas as travas passam", async () => {
  const core = await readFile(new URL("../app/plataforma/features/core.tsx", import.meta.url), "utf8");
  // Uma condição só, com todas as exigências — não um botão que habilita cedo.
  assert.match(core, /reason\.trim\(\)\.length >= reasonMinLength/u);
  assert.match(core, /confirmation === action\.typedConfirmation/u);
});
