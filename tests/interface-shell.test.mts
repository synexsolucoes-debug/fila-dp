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
  const css = (await lerCss("app/dashboard-modern.css")).replace(/\r\n/gu, "\n");
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

test("o segundo nível não vira alvo invisível de 19px no notebook", async () => {
  const css = (await lerCss("app/dashboard-modern.css")).replace(/\r\n?/gu, "\n");
  const base = css.indexOf(".sidebar-process-views {");
  const compacto = css.lastIndexOf("@media (max-width: 1180px) and (min-width: 761px)");
  assert.ok(compacto > base, "o override compacto precisa vir depois da declaração-base para vencer a cascata");
  assert.match(css.slice(compacto), /\.sidebar-process-views \{ display: none; \}/u,
    "submódulos sem ícone devem sair do trilho compacto; continuam no cabeçalho contextual");
});

test("o layout de celular continua rolando pelo documento", async () => {
  const css = (await lerCss("app/dashboard-modern.css")).replace(/\r\n?/gu, "\n");
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
  const modulos = ["payments", "time", "integrations", "auxiliary", "operations", "registrations"];
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
  const modulos = ["payments", "time", "integrations", "auxiliary", "operations", "registrations"];
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

test("os anexos agrupam ações sem sobreposição e usam o contraste do tema", async () => {
  const [workspace, css] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    lerCss("app/dashboard-modern.css"),
  ]);
  assert.match(workspace, /className="attachment-actions"/u,
    "visualizar, baixar e excluir precisam ocupar uma única célula de ações");
  assert.match(workspace, /className="attachment-delete-button"/u);
  assert.doesNotMatch(css, /grid-template-columns:\s*36px minmax\(0, 1fr\) auto auto 26px/u,
    "cada ação em uma coluna própria volta a comprimir e sobrepor os rótulos");
  assert.match(css, /\.attachment-list > article \{[^}]*background: var\(--ui-surface\); color: var\(--ui-text\)/u,
    "o card não pode manter fundo branco com texto herdado do tema escuro");
  assert.match(css, /\.attachment-list > article strong \{ color: var\(--ui-text\); \}/u);
  assert.match(css, /\.attachment-list > article span \{ color: var\(--ui-text-soft\); \}/u);
  assert.match(css, /\.attachment-actions > \.attachment-preview-button \{[^}]*width: auto/u,
    "Visualizar não pode voltar à largura fixa de 24 px");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.attachment-actions \{ grid-column: 2;[^}]*flex-wrap: wrap;/u,
    "as ações precisam quebrar linha em telas estreitas");
});

test("o estado da transferência Sólides usa pares semânticos legíveis nos dois temas", async () => {
  const [workspace, css] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    lerCss("app/dashboard-modern.css"),
  ]);
  assert.match(workspace, /role=\{sync\.state === "FAILED" \? "alert" : "status"\} aria-live="polite"/u,
    "o resultado da transferência precisa ser anunciado sem depender apenas da cor");
  assert.match(css, /\.solides-attachment-sync\.success \{[^}]*background: var\(--ui-state-ok-bg\); color: var\(--ui-state-ok-text\);/u,
    "sucesso precisa usar o par de fundo e texto que muda junto com o tema");
  assert.match(css, /\.solides-attachment-sync\.working \{[^}]*var\(--ui-state-warn-bg\)[^}]*var\(--ui-state-warn-text\)/u);
  assert.match(css, /\.solides-attachment-sync\.error \{[^}]*var\(--ui-state-danger-bg\)[^}]*var\(--ui-state-danger-text\)/u);
  assert.match(css, /\.solides-attachment-sync:is\(\.working, \.success, \.error\) :is\(span, strong, p\) \{ color: inherit; \}/u,
    "título e descrição não podem herdar o texto claro do modal sobre um aviso claro");
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

/* -------------------------------------------------------------------------- */
/* Escala de superfície (§5, §6, §7)                                          */
/* -------------------------------------------------------------------------- */

test("as duas escalas têm quatro degraus de superfície, e nenhum é branco puro", async () => {
  /* A queixa da §5 é literal: "não quero o sistema branco". O tema claro
     anterior era `#ffffff` de cartão sobre `#f5f7f9` de fundo — 1,03:1 entre os
     dois, o que não é hierarquia, é uma folha de papel com texto. O escuro
     tinha o mesmo defeito pelo avesso, e nenhum degrau acima da superfície:
     modal e menu suspenso caíam no mesmo tom do cartão que os abriu.

     O produto entrega um tema só, o escuro. A escala clara continua medida
     porque ela é a camada base: `.theme-dark` sobrescreve os quatro tokens,
     mas qualquer regra futura que escape da sobrescrita resolve contra ela. Um
     `#ffffff` de volta ali é uma superfície branca esperando a primeira regra
     distraída — e a §5 existe justamente para isso não acontecer. */
  const css = (await lerCss("app/dashboard-modern.css")).replaceAll("\r\n", "\n");
  const bloco = (seletor: string) => {
    const inicio = css.indexOf(seletor);
    return css.slice(inicio, css.indexOf("\n}", inicio));
  };
  const claro = bloco(".dashboard-shell {\n  /* A identidade vem dos tokens");
  const escuro = bloco(".dashboard-shell.theme-dark {");

  for (const [nome, tema] of [["claro", claro], ["escuro", escuro]] as const) {
    /* `iu`, e não `u`: hexadecimal em maiúscula é o mesmo valor. Sem o `i` esta
       conferência tinha dois furos — um token em `#0D1512` era lido como
       ausente (foi assim que ela quebrou), e, pior, um `#FFFFFF` de volta na
       escala passaria batido justamente pela regra que existe para barrá-lo. */
    for (const token of ["--ui-bg", "--ui-surface", "--ui-surface-elevated", "--ui-surface-muted"]) {
      const valor = tema.match(new RegExp(`${token}:\\s*(#[0-9a-f]{3,8})`, "iu"))?.[1];
      assert.ok(valor, `o tema ${nome} não declara ${token}`);
      assert.notEqual(valor!.toLowerCase(), "#ffffff", `${token} no tema ${nome} é branco puro`);
      assert.notEqual(valor!.toLowerCase(), "#fff", `${token} no tema ${nome} é branco puro`);
    }
    // Quatro valores distintos: dois degraus iguais são um degrau.
    const degraus = ["--ui-bg", "--ui-surface", "--ui-surface-elevated", "--ui-surface-muted"]
      .map((token) => tema.match(new RegExp(`${token}:\\s*(#[0-9a-f]{3,8})`, "iu"))?.[1]?.toLowerCase());
    assert.equal(new Set(degraus).size, 4, `o tema ${nome} repete um degrau da escala`);
  }
});

test("todo preenchimento colorido declara o que se lê em cima dele", async () => {
  /* `--ui-on-danger` era consumido pelo módulo de Processos — `color:
     var(--ui-on-danger)` no botão de arquivar — e não existia em lugar nenhum
     do projeto. Uma variável indefinida não avisa: a declaração cai no valor
     computado e o texto herda a cor do pai. No tema escuro isso era vermelho
     claro sobre vermelho claro. */
  const css = await lerCss("app/dashboard-modern.css");
  for (const token of ["--ui-on-accent", "--ui-on-danger", "--ui-on-done"]) {
    assert.ok((css.split(`${token}:`).length - 1) >= 2,
      `${token} precisa de valor no claro e no escuro`);
  }
  // E nenhum token consumido pelo painel pode ficar sem dono. A varredura é
  // sobre os CSS de módulo, que foi onde o defeito nasceu.
  const definidos = new Set([...css.matchAll(/(--ui-[\w-]+):/gu)].map((match) => match[1]));
  const globais = await lerCss("app/globals.css");
  for (const match of globais.matchAll(/(--ui-[\w-]+):/gu)) definidos.add(match[1]);

  const orfaos = new Set<string>();
  for (const modulo of await readdir(new URL("../app/painel/features/", import.meta.url))) {
    const dir = new URL(`${modulo}/`, new URL("../app/painel/features/", import.meta.url));
    const arquivos = await readdir(dir).catch(() => [] as string[]);
    for (const nome of arquivos.filter((arquivo) => arquivo.endsWith(".module.css"))) {
      const conteudo = await readFile(new URL(nome, dir), "utf8");
      for (const uso of conteudo.matchAll(/var\(\s*(--ui-[\w-]+)\s*[,)]/gu)) {
        if (!definidos.has(uso[1])) orfaos.add(`${modulo}/${nome}: ${uso[1]}`);
      }
    }
  }
  assert.deepEqual([...orfaos], [], "token consumido e nunca declarado — a regra some sem avisar");
});

test("o token de preenchimento não é usado como cor de texto", async () => {
  /* Um acento tem dois papéis e duas cores. `--pay-accent` é o que pinta o
     fundo do botão primário; `--pay-accent-text` é a mesma família em um tom
     que se lê sobre a página. Trocar um pelo outro não quebra nada visível no
     tema claro, onde os dois quase coincidem — e some no escuro.
     Foi o que aconteceu: `.secondaryButton:hover` em Pagamentos pintava o
     texto com o preenchimento, e no tema escuro, dentro de Prestadores PJ, o
     âmbar #9a5c20 sobre o navy #12203a dava 3.04:1. O botão ficava ilegível
     exatamente quando o ponteiro estava em cima dele.
     A varredura de acessibilidade só pegou isso por acaso, porque o ponteiro
     parou ali depois de um clique. Este teste não depende de sorte. */
  const raiz = new URL("../app/painel/features/", import.meta.url);
  const infracoes: string[] = [];
  for (const modulo of await readdir(raiz)) {
    const dir = new URL(`${modulo}/`, raiz);
    const arquivos = await readdir(dir).catch(() => [] as string[]);
    for (const nome of arquivos.filter((arquivo) => arquivo.endsWith(".module.css"))) {
      const conteudo = await readFile(new URL(nome, dir), "utf8");
      conteudo.split("\n").forEach((linha, indice) => {
        // `color:` — não `border-color:`, `background-color:` nem `caret-color:`,
        // onde o preenchimento é justamente o token certo.
        for (const uso of linha.matchAll(/(^|[^-\w])color:\s*var\(\s*(--[\w-]*-accent)\s*[,)]/gu)) {
          // `--*-on-accent` é o par legítimo: o que se lê EM CIMA do
          // preenchimento, dentro do botão que ele pinta.
          if (uso[2].endsWith("-on-accent")) continue;
          infracoes.push(`${modulo}/${nome}:${indice + 1} usa ${uso[2]} como cor de texto`);
        }
      });
    }
  }
  assert.deepEqual(infracoes, [], "cor de texto precisa vir do token de texto, não do de preenchimento");
});

/* -------------------------------------------------------------------------- */
/* Tokens de layout e de movimento (§42, §78)                                 */
/* -------------------------------------------------------------------------- */

test("recuo, intervalo e largura são medida única, não escolha de cada módulo", async () => {
  const css = await lerCss("app/dashboard-modern.css");
  for (const token of ["--layout-sidebar-width", "--layout-sidebar-collapsed", "--layout-header-height",
    "--layout-page-padding", "--layout-page-gap", "--layout-section-gap", "--layout-card-padding",
    "--layout-content-max"]) {
    assert.ok(css.includes(`${token}:`), `falta ${token}`);
  }
  // E a casca consome os seus, em vez de repetir o número.
  assert.match(css, /grid-template-columns: var\(--layout-sidebar-width\)/u);
  assert.match(css, /grid-template-columns: var\(--layout-sidebar-collapsed\)/u);
});

test("a barra recolhida troca a marca e remove adornos que não cabem", async () => {
  const [workspace, css] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    lerCss("app/dashboard-modern.css"),
  ]);

  assert.match(workspace, /dashboard-brand-logo-full[^\n]*<VinculatoLogo[^>]*tone="light"/u,
    "a assinatura horizontal precisa continuar disponível no cabeçalho móvel");
  assert.match(workspace, /dashboard-brand-logo-mark[^\n]*<VinculatoLogo[^>]*compact/u,
    "a barra recolhida precisa usar o símbolo oficial em vez de recortar o logotipo");
  assert.match(css, /\.sidebar-collapsed \.dashboard-brand-logo-full\s*\{\s*display:\s*none;/u);
  assert.match(css, /\.sidebar-collapsed \.dashboard-brand-logo-mark\s*\{\s*display:\s*inline-flex;/u);
  assert.match(css, /\.sidebar-collapsed \.sidebar-shortcut-mark\s*\{\s*display:\s*none;/u,
    "a marca secundaria vira um icone solto quando o rotulo do atalho desaparece");
  assert.match(css, /\.sidebar-collapsed \.dashboard-sidebar nav\s*\{\s*scrollbar-width:\s*none;/u,
    "o trilho de rolagem não pode consumir a largura da barra compacta");
  assert.match(css, /\.sidebar-collapsed \.sidebar-account-actions\s*\{[^}]*flex-direction:\s*column;/u,
    "as duas acoes da conta precisam caber sem cortar o botao de sair");
});

test("as durações têm nome por papel, e as curvas separam entrar de sair", async () => {
  // A §78 pede que a interface inteira fale a mesma língua de movimento. Nome
  // por papel é o que permite isso: quem escreve um menu suspenso novo pega
  // `--motion-dropdown` sem precisar lembrar se o número era 180 ou 220.
  const css = await lerCss("app/dashboard-modern.css");
  for (const token of ["--motion-hover", "--motion-micro", "--motion-dropdown", "--motion-modal",
    "--motion-drawer", "--motion-page", "--ease-standard", "--ease-enter", "--ease-exit",
    "--motion-distance-sm", "--motion-distance-md"]) {
    assert.ok(css.includes(`${token}:`), `falta ${token}`);
  }
  // Nenhuma duração acima de 400ms: a §11 é explícita sobre não prejudicar a
  // produtividade, e acima disso o movimento deixa de parecer resposta.
  for (const [, valor] of css.matchAll(/--motion-(?:hover|micro|dropdown|modal|drawer|page):\s*(\d+)ms/gu)) {
    assert.ok(Number(valor) <= 400, `duração de ${valor}ms passa do teto da §11`);
  }
});

test("a biblioteca de movimento só anima transform e opacity", async () => {
  const css = await lerCss("app/painel/features/shared/motion.module.css");
  for (const [, nome] of css.matchAll(/@keyframes (\w+)/gu)) {
    const inicio = css.indexOf(`@keyframes ${nome}`);
    const corpo = css.slice(inicio, css.indexOf("\n}", inicio));
    for (const [, prop] of corpo.matchAll(/^\s*([a-z-]+):/gmu)) {
      assert.ok(["transform", "opacity"].includes(prop),
        `${nome} anima "${prop}", que custa layout a cada quadro`);
    }
  }
  /* E os componentes não escrevem milissegundo próprio: tudo vem de token.
     O valor de reserva dentro de `var(--token, 0ms)` não conta — ele espelha o
     token e existe para o caso de ele não ter sido definido, que é o mesmo
     critério que `tests/design-tokens.test.mts` usa para cor. */
  const semComentario = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const semReserva = semComentario.replace(/var\(\s*--[\w-]+\s*,\s*[^)]*\)/gu, "VAR");
  const duracoesCruas = [...semReserva.matchAll(/(?:animation|transition)[^;]*?\b(\d+)ms/gu)]
    .map((match) => match[1]);
  assert.deepEqual(duracoesCruas, [], "duração escrita à mão; use os tokens --motion-*");
});

test("quem pede menos movimento recebe menos movimento também na biblioteca", async () => {
  const css = await lerCss("app/painel/features/shared/motion.module.css");
  const bloco = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(bloco, /animation: none !important;/u);
  for (const alvo of ["pageTransition", "backdrop", "modal", "drawer", "staggerItem"]) {
    assert.ok(bloco.includes(alvo), `falta desligar a animação de ${alvo}`);
  }
  // A versão reduzida não é "sem transição nenhuma": a mudança de cor continua
  // explicando o que aconteceu. O que sai é o deslocamento.
  assert.match(bloco, /transition-property: background-color, border-color, color;/u);
  assert.match(bloco, /transform: none;/u);
});

/* -------------------------------------------------------------------------- */
/* Componentes compartilhados (§51, §53)                                      */
/* -------------------------------------------------------------------------- */

test("a página inteira carrega com esqueleto, não com um rodopio sem forma", async () => {
  // §51: "Não mostrar Loading... em uma página corporativa sem necessidade."
  // `LoadingState` continua valendo para uma faixa dentro de uma tela já
  // desenhada; para a tela inteira o esqueleto diz a forma do que vem.
  const shared = await readFile(new URL("../app/painel/features/shared/panel-ui.tsx", import.meta.url), "utf8");
  assert.match(shared, /export function PageSkeleton/u);
  assert.match(shared, /role="status" aria-busy="true" aria-live="polite"/u);

  const semEsqueleto: string[] = [];
  const raiz = new URL("../app/painel/features/", import.meta.url);
  for (const modulo of await readdir(raiz)) {
    const dir = new URL(`${modulo}/`, raiz);
    for (const nome of (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".tsx"))) {
      const fonte = await readFile(new URL(nome, dir), "utf8");
      if (/<LoadingState size="page"/u.test(fonte)) semEsqueleto.push(`${modulo}/${nome}`);
    }
  }
  assert.deepEqual(semEsqueleto, [], "carregamento de página inteira ainda usa o rodopio");
});

test("a confirmação destrutiva exige dizer o que vai acontecer", async () => {
  /* §53: o diálogo não pergunta "tem certeza?" — ele diz a consequência
     ("irá retirar 2 unidades do estoque disponível"). Por isso `consequence` é
     obrigatória no tipo: um diálogo sem ela devolve a pergunta a quem já
     clicou e não acrescenta nada para decidir. */
  const shared = await readFile(new URL("../app/painel/features/shared/panel-ui.tsx", import.meta.url), "utf8");
  const assinatura = shared.slice(shared.indexOf("export function ConfirmDialog"));
  assert.match(assinatura.slice(0, 400), /consequence: string;/u,
    "a consequência não pode ser opcional");
  // `alertdialog` e não `dialog`: é a função que o ARIA reserva para uma
  // interrupção que exige resposta.
  assert.match(assinatura, /role="alertdialog" aria-modal="true"/u);
  assert.match(assinatura, /aria-describedby="confirm-consequence"/u);
  // Esc não escapa no meio de uma ação já enviada.
  const motion = await readFile(new URL("../app/painel/features/shared/motion.tsx", import.meta.url), "utf8");
  assert.match(motion, /event\.key === "Escape" && !busy/u);
  assert.match(motion, /previous\?\.focus\?\.\(\)/u, "o foco volta para onde estava");
});
