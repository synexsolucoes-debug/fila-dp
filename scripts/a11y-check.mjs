/**
 * Conferência WCAG 2.2 AA nas telas principais, contra o app rodando.
 *
 * Verifica três critérios que dá para medir sem julgamento humano:
 *   1.4.3 Contraste mínimo   — 4.5:1 (3:1 para texto grande)
 *   4.1.2 Nome, função, valor — todo controle precisa de nome acessível
 *   2.5.8 Tamanho do alvo    — 24x24 CSS px, exceto alvo dentro de frase
 *
 * Sobre gradiente a medição não é opcional: a primeira versão desta checagem
 * pulava superfícies com `background-image` e, com isso, deixava passar três
 * textos reais entre 3.09:1 e 4.09:1. Aqui as paradas do gradiente são
 * extraídas e o texto é medido contra a pior delas — inclusive compondo
 * camadas translúcidas sobre as opacas. É conservador de propósito: uma
 * aprovação precisa valer para o gradiente inteiro, não para o ponto médio.
 *
 * Uso: npm run a11y-check   (requer o app em http://localhost:3000)
 */
import { chromium } from "playwright";

const BASE = process.env.A11Y_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.A11Y_EMAIL ?? "admin@vinculato.test";
const PASSWORD = process.env.A11Y_PASSWORD ?? "EnsaioLocal!2026";



const AUDIT = () => {
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg, bg) => {
    const a = luminance(fg) + 0.05;
    const b = luminance(bg) + 0.05;
    return Math.round((Math.max(a, b) / Math.min(a, b)) * 100) / 100;
  };

  /** `rgb()`, `rgba()` e `color(srgb …)` — as três formas que o getComputedStyle devolve. */
  const parseColor = (raw) => {
    const fn = raw.match(/^rgba?\(([^)]+)\)$/u);
    if (fn) {
      const parts = fn[1].split(/[,\s/]+/u).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some(Number.isNaN)) return null;
      return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
    }
    const srgb = raw.match(/^color\(srgb\s+([^)]+)\)$/u);
    if (srgb) {
      const parts = srgb[1].split(/[\s/]+/u).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some(Number.isNaN)) return null;
      return { rgb: parts.slice(0, 3).map((v) => Math.round(v * 255)), alpha: parts.length > 3 ? parts[3] : 1 };
    }
    return null;
  };

  const over = (top, bottom) => top.rgb.map((v, i) => Math.round(v * top.alpha + bottom[i] * (1 - top.alpha)));

  /**
   * Todas as cores de fundo plausíveis de um gradiente. Retorna `null` quando a
   * camada é uma imagem de verdade (`url(...)`), que não dá para medir assim.
   */
  const gradientSurfaces = (backgroundImage, beneath) => {
    if (/url\(/u.test(backgroundImage)) return null;
    const tokens = backgroundImage.match(/(rgba?\([^)]*\)|color\(srgb[^)]*\))/gu) ?? [];
    const colors = tokens.map(parseColor).filter(Boolean);
    if (colors.length === 0) return null;
    const opaque = colors.filter((c) => c.alpha >= 0.99).map((c) => c.rgb);
    const bases = opaque.length > 0 ? opaque : [beneath];
    const surfaces = [...bases];
    for (const layer of colors) {
      if (layer.alpha >= 0.99 || layer.alpha <= 0) continue;
      for (const base of bases) surfaces.push(over(layer, base));
    }
    return surfaces;
  };

  /** Lista de fundos possíveis atrás do elemento, do mais próximo ao <html>. */
  const backgroundsBehind = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== "none") {
        const beneath = backgroundsBehind(node.parentElement ?? document.documentElement);
        const base = beneath && beneath.length > 0 ? beneath[0] : [255, 255, 255];
        return gradientSurfaces(style.backgroundImage, base);
      }
      const bg = parseColor(style.backgroundColor);
      if (bg && bg.alpha > 0.5) return [bg.rgb];
      node = node.parentElement;
    }
    return [[255, 255, 255]];
  };

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden"
      && style.display !== "none" && Number(style.opacity) > 0.1;
  };

  const contrastIssues = [];
  const nameIssues = [];
  const targetIssues = [];
  const unmeasurable = [];

  const selector = "button, a, input, select, textarea, p, span, small, strong, h1, h2, h3,"
    + " label, td, th, li, dt, dd, summary";

  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    const text = (el.textContent ?? "").trim();
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const style = getComputedStyle(el);
    const cls = (el.className || "").toString().split(" ")[0];
    /* Um elemento sem classe própria — `<th>`, `<strong>`, `<span>` solto — era
       reportado como "STRONG. 1.31:1" e não dava para achar no código. A cadeia
       de ancestrais com classe transforma o relatório em endereço. */
    const trail = (() => {
      const parts = [];
      let node = el.parentElement;
      while (node && parts.length < 3 && node !== document.body) {
        const name = (node.className || "").toString().trim().split(/\s+/u)[0];
        if (name) parts.unshift(name);
        node = node.parentElement;
      }
      return parts.join(" > ");
    })();

    if (ownText && text) {
      const fg = parseColor(style.color);
      if (fg && fg.alpha > 0.5) {
        const size = parseFloat(style.fontSize);
        const bold = Number(style.fontWeight) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        const surfaces = backgroundsBehind(el);
        if (surfaces === null) {
          unmeasurable.push({ tag: el.tagName, cls, text: text.slice(0, 40) });
        } else {
          // Pior parada do gradiente: aprovar pela média esconderia a borda ruim.
          const value = Math.min(...surfaces.map((bg) => ratio(fg.rgb, bg)));
          if (value < need) {
            /* A cor medida vai junto do número.
               Sem ela, "1.64:1" não diz o que aconteceu: se o texto perdeu a
               cor, se o fundo não aplicou, ou se a medição pegou outra
               superfície. Isso custou uma investigação inteira — a varredura
               acusava um contraste que o navegador local não reproduzia, e o
               relatório não trazia nada com que comparar. */
            const pior = surfaces.reduce((a, b) => (ratio(fg.rgb, a) <= ratio(fg.rgb, b) ? a : b));
            contrastIssues.push({
              tag: el.tagName, cls, trail, text: text.slice(0, 40), value, need, size,
              fg: `rgb(${fg.rgb.join(", ")})`, bg: `rgb(${pior.join(", ")})`,
            });
          }
        }
      }
    }

    if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/u.test(el.tagName)) {
      const labels = el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent).join(" ") : "";
      const name = (el.getAttribute("aria-label") || el.getAttribute("title") || text
        || labels || el.getAttribute("placeholder") || "").trim();
      if (!name) nameIssues.push({ tag: el.tagName, cls, html: el.outerHTML.slice(0, 70) });
      const rect = el.getBoundingClientRect();
      // 2.5.8 dispensa alvo "in a sentence": link corrido dentro de texto.
      const inSentence = el.tagName === "A" && style.display === "inline";
      if (!inSentence && (rect.height < 24 || rect.width < 24)) {
        targetIssues.push({
          tag: el.tagName, cls, w: Math.round(rect.width), h: Math.round(rect.height), name: name.slice(0, 24),
        });
      }
    }
  }

  const overflowIssues = document.documentElement.scrollWidth > window.innerWidth + 1
    ? [{ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }]
    : [];

  return { contrastIssues, nameIssues, targetIssues, unmeasurable, overflowIssues };
};

/* O navegador é o que o Playwright instalou, e não um caminho adivinhado.
   A versão anterior procurava `chromium-<revisão>` em PLAYWRIGHT_BROWSERS_PATH e
   montava `chrome-linux/chrome` na mão. Isso quebra de duas formas, e as duas
   aconteceram: o layout do pacote virou `chrome-linux64/` nas revisões novas, e
   `find()` devolve a PRIMEIRA revisão encontrada — com uma instalação antiga ao
   lado da atual, a conferência roda num Chromium que não é o do projeto. Foi
   assim que esta varredura passou local no Chromium 141 e reprovou na CI no 151,
   com 53 violações reais que a versão velha não media. Sem executablePath, o
   Playwright resolve o binário que ele mesmo fixou; faltando, ele falha dizendo
   para instalar, em vez de medir com outro motor em silêncio. */
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });

// Alvo e contraste mudam com o layout: um botão que tem folga no desktop pode
// encolher no celular. As duas larguras precisam passar.
const VIEWPORTS = [
  { label: "desktop 1440", width: 1440, height: 900 },
  { label: "notebook 1024", width: 1024, height: 768 },
  { label: "tablet 768", width: 768, height: 1024 },
  { label: "celular 390", width: 390, height: 844 },
];

let failures = 0;
let screensAudited = 0;

/**
 * Piso de cobertura.
 *
 * A varredura completa mede 64 telas — o painel, os dois níveis do menu, as
 * abas de dentro de cada módulo, o assistente e o console global, num tema só.
 *
 * O piso existe porque este script já falhou do jeito mais perigoso que um
 * verificador pode falhar: passando. Um seletor de navegação que deixou de
 * casar tirou 32 telas da varredura, e a conclusão impressa continuou sendo
 * "OK: 0 violações" — 0 violações em nada.
 *
 * Ele subiu de 40 para 55 quando as abas de dentro dos módulos entraram na
 * varredura. Vale registrar o que aquela entrada revelou, porque é a medida do
 * que um piso baixo esconde: as dez abas do Controle de EPI, as nove da gestão
 * de Processos e as quatro do quadro **nunca tinham sido medidas** — a
 * varredura visitava o módulo, auditava a primeira aba e seguia adiante. A
 * primeira passagem com elas dentro acusou 122 violações de contraste, todas
 * reais, todas em rótulos que existiam há meses.
 *
 * Subiu de novo, de 55 para 64, quando a Central de Trabalho, a Triagem e a
 * Central de Agentes entraram no menu: um piso que não acompanha o produto
 * volta a tolerar exatamente o colapso que ele existe para acusar — as três
 * telas novas poderiam sumir da varredura inteira sem baixar de 55.
 *
 * Subiu de 64 para 75 quando o site comercial entrou na varredura. Até aqui ela
 * media a home e o login e mais nada de fora do produto: /planos, /solucao,
 * /funcionalidades, /integracoes, /demonstracao, /contato, /faq, /termos,
 * /privacidade, /subprocessadores e /recuperar — onze telas públicas, as que o
 * cliente vê antes de contratar — nunca haviam sido medidas, e o relatório
 * dizia "0 violações" sobre elas do mesmo jeito que já disse sobre metade do
 * painel. Tela que ninguém mede é tela que ninguém conserta.
 *
 * Subiu de 75 para 77 quando as duas gavetas de configuração da integração
 * global entraram. Elas não são telas: só existem depois de um clique, e por
 * isso a varredura media a listagem por trás e declarava a área sem violações
 * enquanto o formulário em cima dela tinha rótulo a 1,58:1 e cabeçalho de seção
 * a 1,03:1 — vinte e cinco violações reais numa área que o relatório dava como
 * limpa.
 *
 * O número continua folgado de propósito — 77 contra 88 medidas — para acusar
 * um colapso de cobertura sem quebrar quando um módulo sai do plano.
 */
const MINIMO_DE_TELAS = 77;

/**
 * `path === null` audita a tela já aberta, sem recarregar — usado nas visões do
 * painel. `viewports` permite medir uma superfície que só existe em uma largura,
 * como o menu do cabeçalho público, sem inventar uma tela nas outras três.
 */
async function audit(label, path, setup, viewports = VIEWPORTS) {
  if (path !== null) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    if (setup) await setup();
    await page.waitForTimeout(1800);
  }
  console.log(`\n### ${label}${path === null ? "" : ` (${path})`}`);
  screensAudited += 1;

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(500);
    const result = await page.evaluate(AUDIT);
    const uniq = (list, key) => [...new Map(list.map((item) => [key(item), item])).values()];
    const contrast = uniq(result.contrastIssues, (i) => `${i.tag}.${i.cls}:${i.trail}:${i.value}:${i.fg}:${i.bg}`);
    const names = uniq(result.nameIssues, (i) => `${i.tag}.${i.cls}`);
    const targets = uniq(result.targetIssues, (i) => `${i.tag}.${i.cls}:${i.name}`);
    const blind = uniq(result.unmeasurable, (i) => `${i.tag}.${i.cls}`);
    const overflows = result.overflowIssues ?? [];

    failures += contrast.length + names.length + targets.length + overflows.length;

    const total = contrast.length + names.length + targets.length + overflows.length;
    console.log(`  ${viewport.label}: ${total === 0 ? "sem violações" : `${total} violação(ões)`}`);
    for (const i of contrast.slice(0, 8)) {
      console.log(`     contraste ${i.tag}.${i.cls || "—"} ${i.value}:1 (precisa ${i.need}) ${i.fg} sobre ${i.bg} "${i.text}" ← ${i.trail}`);
    }
    for (const i of names.slice(0, 5)) console.log(`     sem nome ${i.tag}.${i.cls} → ${i.html}`);
    for (const i of targets.slice(0, 5)) console.log(`     alvo ${i.tag}.${i.cls} ${i.w}x${i.h} "${i.name}"`);
    for (const i of overflows) console.log(`     overflow horizontal ${i.scrollWidth}px em viewport de ${i.viewportWidth}px`);
    if (blind.length > 0) {
      // Não conta como falha, mas também não some: fica registrado para revisão.
      console.log(`     não mensurável (fundo com imagem): ${blind.length}`);
      for (const i of blind.slice(0, 5)) console.log(`       ${i.tag}.${i.cls} "${i.text}"`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * As abas do módulo — os destinos que a barra lateral não alcança.
 *
 * Controle de EPI tem dez destinos próprios, a gestão de Processos tem nove, e
 * até aqui **nenhum deles era medido**: a varredura visitava o módulo, auditava
 * a primeira aba e ia para o módulo seguinte. Trinta e poucas telas de produto
 * ficavam de fora, e o relatório dizia "0 violações" sobre o que não tinha
 * olhado — a mesma classe de ponto cego que o piso de cobertura existe para
 * acusar.
 *
 * O que fica de fora não é um lugar da tela, é uma repetição: as abas que
 * levam ao mesmo destino que o segundo nível do menu, já percorrido. Medir de
 * novo infla o número sem medir nada novo, e um piso inflado é pior que um
 * piso baixo.
 *
 * Antes o filtro era por contêiner — tudo que estivesse no cabeçalho do
 * processo era descartado. Isso valia enquanto o cabeçalho só mostrava módulos.
 * Desde que ele passou a emprestar o lugar ao módulo (§70), o Controle de EPI
 * entrega os seus dez destinos ali, e o filtro por contêiner os apagava da
 * varredura: dez telas reais somem do relatório por estarem no lugar certo.
 * Por isso a comparação agora é com os rótulos do menu, que é o que de fato
 * define a duplicata.
 */
async function auditModuleTabs(prefix) {
  const dentro = '.process-context [role="tab"], .dashboard-content [role="tab"], .dashboard-content [class*="tabs"] > button';
  const menu = page.locator('nav[aria-label="Navegação do painel"] .sidebar-process-view');
  const menuLabels = new Set((await menu.allInnerTexts()).map((text) => text.trim().split("\n")[0]));
  const tabs = page.locator(dentro);
  const labels = [...new Set((await tabs.allInnerTexts()).map((text) => text.trim().split("\n")[0]).filter(Boolean))]
    .filter((label) => !menuLabels.has(label));
  // A primeira já foi auditada com o módulo: ela é o destino de entrada.
  for (const label of labels.slice(1)) {
    await tabs.filter({ hasText: label }).first().click().catch(() => undefined);
    await page.waitForTimeout(1000);
    await audit(`${prefix} › ${label}`, null);
  }
}

/**
 * O assistente fica recolhido por padrão — então nunca entraria na varredura
 * junto com a tela que o hospeda. Aqui ele é aberto de propósito: um painel que
 * só aparece quando chamado ainda precisa ser legível quando aparece.
 */
async function auditAssistant(theme = "") {
  const launcher = page.locator('button[class*="launcher"]').filter({ hasText: /Assistente/u }).first();
  if (await launcher.count() === 0) {
    console.log("\n### Assistente — lançador não encontrado");
    failures += 1;
    return;
  }
  await launcher.click();
  await page.locator('aside[aria-label="Assistente do Vinculato"]').waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(1200);
  await audit(`Painel › Assistente${theme ? ` [${theme}]` : ""}`, null);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
}

async function signIn() {
  if (!page.url().includes("/login")) return;
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => undefined),
    page.getByRole("button", { name: /^Entrar$/u }).last().click(),
  ]);
}

/**
 * O painel troca de tela por estado, não por rota: auditar só `/painel` cobriria
 * a visão geral e mais nada. Aqui a navegação lateral é percorrida de verdade.
 *
 * O menu tem dois níveis desde que passou a agrupar por processo (§25): o
 * primeiro é o processo e o segundo são os módulos dele, que só existem no DOM
 * enquanto aquele processo está aberto. Ler os rótulos uma vez no começo, como
 * a versão anterior fazia, mediria os processos e os módulos de um só deles —
 * e imprimiria "0 violações" sobre a maior parte do produto não visitada. É a
 * mesma falha que já tirou 32 telas desta varredura sem ninguém notar.
 */
async function auditPanelViews(theme = "") {
  const sufixo = theme ? ` [${theme}]` : "";
  // Descendente, não filho direto. O menu agrupou os itens por contexto e o
  // seletor `> button` deixou de casar — sem erro nenhum: a varredura passou a
  // visitar zero telas do painel e a imprimir "0 violações".
  const processos = page.locator('nav[aria-label="Navegação do painel"] .sidebar-process > button, nav[aria-label="Navegação do painel"] > .sidebar-nav-home');
  const rotulos = (await processos.allInnerTexts()).map((text) => text.trim().split("\n")[0]).filter(Boolean);
  if (rotulos.length === 0) {
    console.log("\n### Painel — nenhum item de menu encontrado; a varredura das visões não rodou");
    failures += 1;
    return;
  }

  for (const rotulo of rotulos) {
    await processos.filter({ hasText: rotulo }).first().click().catch(() => undefined);
    await page.waitForTimeout(900);

    // Segundo nível: os módulos do processo recém-aberto. Eles nascem com a
    // abertura, então precisam ser lidos agora, não antes.
    const modulos = page.locator('nav[aria-label="Navegação do painel"] .sidebar-process-view');
    const nomes = (await modulos.allInnerTexts()).map((text) => text.trim().split("\n")[0]).filter(Boolean);

    /* Abrir o processo já leva ao primeiro módulo dele — e o relatório vinha
       chamando essa tela pelo nome do *processo*, não pelo do módulo. O módulo
       de entrada ficava então sem linha própria: procurar "Meu trabalho" no
       relatório não achava nada, e a única leitura possível era a errada — que
       a Central de Trabalho não tinha sido auditada. Cobertura que não dá para
       conferir por nome não serve para dizer que algo foi coberto. */
    const entrada = `Painel › ${rotulo}${nomes[0] ? ` › ${nomes[0]}` : ""}${sufixo}`;
    await audit(entrada, null);
    await auditModuleTabs(entrada);

    for (const nome of nomes.slice(1)) {
      await modulos.filter({ hasText: nome }).first().click().catch(() => undefined);
      await page.waitForTimeout(900);
      await audit(`Painel › ${rotulo} › ${nome}${sufixo}`, null);
      await auditModuleTabs(`Painel › ${nome}${sufixo}`);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
}

/**
 * Troca o tema pelo botão do cabeçalho — o mesmo caminho da pessoa.
 *
 * Este bloco já foi uma sentinela: quando a interface virou exclusivamente
 * escura, a troca foi retirada e no lugar dela ficou uma conferência que
 * reprovava se um alternador voltasse, justamente para o segundo tema não
 * ficar sem auditoria em silêncio. O alternador voltou (§6, §12) e a sentinela
 * cumpriu o papel: a varredura cobre os dois temas de novo.
 *
 * A regra que ela protege continua sendo a mesma — nunca audite metade. "Zero
 * violações" precisa querer dizer zero no produto inteiro, não zero na metade
 * que o script olhou.
 */
/**
 * O produto voltou a ter um tema só.
 *
 * Esta função já foi três coisas, e o histórico importa para não repetir
 * nenhuma delas. Primeiro ela trocava de tema pelo botão do cabeçalho e a
 * varredura cobria os dois. Quando a interface virou exclusivamente escura, o
 * botão sumiu e no lugar da troca ficou uma sentinela: reprovar se um
 * alternador reaparecesse, para o segundo tema nunca ficar sem auditoria em
 * silêncio. Ele reapareceu, a sentinela acusou, e a varredura voltou a cobrir
 * os dois — de um jeito que, na primeira tentativa, media o mesmo tema duas
 * vezes com rótulos trocados.
 *
 * O produto agora tem um tema só de novo, por decisão registrada. A regra que
 * atravessou as três versões é sempre a mesma: **nunca audite metade**. Então
 * a sentinela volta ao posto. Ela não mede tema nenhum; ela vigia o retorno do
 * segundo, que é a única coisa capaz de tornar esta varredura parcial sem que
 * ninguém perceba.
 */
async function themeToggleExists() {
  return await page.locator(".theme-toggle").count() > 0;
}

async function auditEverything() {
  console.log("\n\n═══════════ INTERFACE ═══════════");
  await page.goto(`${BASE}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  if (await themeToggleExists()) {
    console.log("um alternador de tema voltou à interface: a varredura precisa cobrir os dois temas de novo");
    failures += 1;
    return;
  }
  await audit("Painel", null);
  await auditPanelViews();
  await auditAssistant();
  await audit("Console da plataforma", "/plataforma");
  await auditPlatformAreas();
}

/**
 * Áreas do console global.
 *
 * O console troca de área por estado, como o painel: auditar só `/plataforma`
 * cobriria a visão geral e mais nada. Foi exatamente esse tipo de ponto cego
 * que fez a varredura anterior declarar "zero violações" enquanto oito módulos
 * do painel nunca haviam sido visitados.
 */
async function auditPlatformAreas(theme = "") {
  const nav = page.locator('aside[aria-label="Áreas da administração global"] nav button');
  const labels = (await nav.allInnerTexts()).map((text) => text.trim().split("\n")[0]).filter(Boolean);
  if (labels.length === 0) {
    // Antes isto era só um aviso. Não pode ser: sem as áreas do console, a
    // varredura devolve "OK" tendo medido uma tela de onze.
    console.log("\n### Console da plataforma — nenhuma área visível; a varredura não rodou");
    failures += 1;
    return;
  }
  for (const label of labels) {
    await nav.filter({ hasText: label }).first().click().catch(() => undefined);
    await page.waitForTimeout(1100);
    await audit(`Plataforma › ${label}${theme ? ` [${theme}]` : ""}`, null);
    if (label.startsWith("Integrações")) await auditIntegrationDrawer(theme);
  }
}

/**
 * A gaveta de configuração da integração global.
 *
 * Ela é a superfície mais densa do console — motivo administrativo, endpoint,
 * rotina, agendamento, credencial dedicada — e nunca havia sido medida, porque
 * só existe depois de um clique. A varredura media a listagem por trás e
 * declarava a área sem violações; a gaveta em cima dela ficava com cabeçalho de
 * seção quase preto sobre superfície escura, botão de salvar em lavanda clara
 * com texto branco e o resumo da credencial ilegível. Mesma classe de ponto
 * cego do assistente do painel e do menu do site, que já entraram por isso.
 *
 * Duas gavetas são abertas de propósito: a de um conector comum e a do Sankhya,
 * que traz o formulário administrativo completo e não compartilha as regras do
 * primeiro.
 */
async function auditIntegrationDrawer(theme = "") {
  const sufixo = theme ? ` [${theme}]` : "";
  const abrir = page.getByRole("button", { name: /^Configurar/u });
  const total = await abrir.count();
  if (total === 0) {
    console.log("\n### Plataforma › Integrações › gaveta — nenhum botão de configuração; a varredura não rodou");
    failures += 1;
    return;
  }

  /* A gaveta do Sankhya é a que carrega o formulário administrativo inteiro, e
     é por isso que ela é procurada pelo nome em vez de pela posição: abrir "a
     primeira" mediria duas vezes o mesmo conector se a ordem mudasse. */
  const cartoes = page.locator(".integrationGrid > article, [class*='integrationGrid'] > article");
  const alvos = [{ rotulo: "conector", indice: 0 }];
  const sankhya = cartoes.filter({ hasText: /Sankhya/u });
  if (await sankhya.count() > 0) alvos.push({ rotulo: "Sankhya", cartao: sankhya.first() });

  for (const alvo of alvos) {
    const botao = alvo.cartao
      ? alvo.cartao.getByRole("button", { name: /^Configurar/u }).first()
      : abrir.nth(alvo.indice);
    await botao.click().catch(() => undefined);
    await page.locator('[role="dialog"]').first().waitFor({ state: "visible", timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1400);
    if (await page.locator('[role="dialog"]').count() === 0) {
      console.log(`\n### Plataforma › Integrações › gaveta (${alvo.rotulo}) — não abriu`);
      failures += 1;
      continue;
    }
    await audit(`Plataforma › Integrações › gaveta (${alvo.rotulo})${sufixo}`, null);
    await page.getByRole("button", { name: /^Fechar$/u }).first().click().catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(700);
  }
}

/**
 * O site comercial inteiro, não só a home.
 *
 * A lista precisa acompanhar `lib/site-map.ts` — é o mesmo conjunto que alimenta
 * o sitemap. `tests/site-launch.test.mts` compara as duas e reprova a divergência:
 * uma página nova que entra no sitemap e não entra aqui nasce sem auditoria, que
 * é exatamente o silêncio que o piso de cobertura existe para acusar.
 */
const PAGINAS_PUBLICAS = [
  ["Home pública", "/"],
  ["Solução", "/solucao"],
  ["Funcionalidades", "/funcionalidades"],
  ["Integrações", "/integracoes"],
  ["Planos", "/planos"],
  ["FAQ", "/faq"],
  ["Contato", "/contato"],
  ["Demonstração", "/demonstracao"],
  ["Privacidade", "/privacidade"],
  ["Termos de uso", "/termos"],
  ["Subprocessadores", "/subprocessadores"],
];

/**
 * O menu do cabeçalho público fica recolhido, e só existe abaixo de 1180px.
 * Medir a home fechada nunca o alcançaria — a mesma razão pela qual o assistente
 * do painel é aberto de propósito antes de ser auditado.
 */
async function auditSiteMenu() {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  const toggle = page.locator(".site-menu-toggle");
  if (await toggle.count() === 0) {
    console.log("\n### Home pública › Menu — botão não encontrado em 390px");
    failures += 1;
    return;
  }
  await toggle.first().click();
  await page.waitForTimeout(500);
  await audit("Home pública › Menu aberto", null, undefined, [{ label: "celular 390", width: 390, height: 844 }]);
}

try {
  for (const [label, path] of PAGINAS_PUBLICAS) await audit(label, path);
  await auditSiteMenu();
  await audit("Login", "/login");
  await audit("Recuperar acesso", "/recuperar");
  await audit("Painel", "/painel", async () => {
    await signIn();
    await page.goto(`${BASE}/painel`, { waitUntil: "domcontentloaded" });
  });
  await auditEverything();
} finally {
  await browser.close();
}

if (screensAudited < MINIMO_DE_TELAS) {
  console.log(`\nCOBERTURA INSUFICIENTE: ${screensAudited} tela(s) auditada(s), mínimo ${MINIMO_DE_TELAS}.`);
  console.log("Uma varredura que não alcança as telas não prova nada sobre elas.");
  failures += 1;
} else {
  console.log(`\n${screensAudited} tela(s) auditada(s).`);
}
console.log(`${failures === 0 ? "OK" : "FALHOU"}: ${failures} violação(ões) WCAG 2.2 AA.`);
process.exit(failures === 0 ? 0 : 1);
