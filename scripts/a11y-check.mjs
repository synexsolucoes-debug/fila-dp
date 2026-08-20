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
import { readdirSync, existsSync } from "node:fs";

const BASE = process.env.A11Y_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.A11Y_EMAIL ?? "admin@vinculato.test";
const PASSWORD = process.env.A11Y_PASSWORD ?? "EnsaioLocal!2026";

const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const installed = existsSync(browsersRoot)
  ? readdirSync(browsersRoot).find((entry) => /^chromium-\d+$/u.test(entry))
  : undefined;

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
            contrastIssues.push({ tag: el.tagName, cls, trail, text: text.slice(0, 40), value, need, size });
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

  return { contrastIssues, nameIssues, targetIssues, unmeasurable };
};

const browser = await chromium.launch(
  installed ? { executablePath: `${browsersRoot}/${installed}/chrome-linux/chrome` } : {},
);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });

// Alvo e contraste mudam com o layout: um botão que tem folga no desktop pode
// encolher no celular. As duas larguras precisam passar.
const VIEWPORTS = [
  { label: "desktop 1440", width: 1440, height: 900 },
  { label: "celular 390", width: 390, height: 844 },
];

let failures = 0;
let screensAudited = 0;

/**
 * Piso de cobertura.
 *
 * A varredura completa mede 47 telas — o painel, o console e as subabas. Eram
 * 59 quando a interface tinha dois temas e cada tela era medida duas vezes; com
 * um tema só, o mesmo alcance custa uma passagem.
 *
 * O piso existe porque este script já falhou do jeito mais perigoso que um
 * verificador pode falhar: passando. Um seletor de navegação que deixou de casar
 * tirou 32 telas da varredura, e a conclusão impressa continuou sendo "OK: 0
 * violações" — 0 violações em nada. O número é folgado de propósito: acusa um
 * colapso de cobertura sem quebrar quando um módulo sai do plano.
 */
const MINIMO_DE_TELAS = 40;

/** `path === null` audita a tela já aberta, sem recarregar — usado nas visões do painel. */
async function audit(label, path, setup) {
  if (path !== null) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    if (setup) await setup();
    await page.waitForTimeout(1800);
  }
  console.log(`\n### ${label}${path === null ? "" : ` (${path})`}`);
  screensAudited += 1;

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(500);
    const result = await page.evaluate(AUDIT);
    const uniq = (list, key) => [...new Map(list.map((item) => [key(item), item])).values()];
    const contrast = uniq(result.contrastIssues, (i) => `${i.tag}.${i.cls}:${i.trail}:${i.value}`);
    const names = uniq(result.nameIssues, (i) => `${i.tag}.${i.cls}`);
    const targets = uniq(result.targetIssues, (i) => `${i.tag}.${i.cls}:${i.name}`);
    const blind = uniq(result.unmeasurable, (i) => `${i.tag}.${i.cls}`);

    failures += contrast.length + names.length + targets.length;

    const total = contrast.length + names.length + targets.length;
    console.log(`  ${viewport.label}: ${total === 0 ? "sem violações" : `${total} violação(ões)`}`);
    for (const i of contrast.slice(0, 8)) {
      console.log(`     contraste ${i.tag}.${i.cls || "—"} ${i.value}:1 (precisa ${i.need}) "${i.text}" ← ${i.trail}`);
    }
    for (const i of names.slice(0, 5)) console.log(`     sem nome ${i.tag}.${i.cls} → ${i.html}`);
    for (const i of targets.slice(0, 5)) console.log(`     alvo ${i.tag}.${i.cls} ${i.w}x${i.h} "${i.name}"`);
    if (blind.length > 0) {
      // Não conta como falha, mas também não some: fica registrado para revisão.
      console.log(`     não mensurável (fundo com imagem): ${blind.length}`);
      for (const i of blind.slice(0, 5)) console.log(`       ${i.tag}.${i.cls} "${i.text}"`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * Sub-abas de uma tela do painel.
 *
 * Auditar a visão de Cadastros cobria só a primeira aba. Prestadores PJ,
 * Colaboradores e Cadastros auxiliares são telas diferentes com formulários
 * diferentes — cada uma precisa passar por si.
 */
async function auditSubTabs(prefix, selector) {
  const tabs = page.locator(selector);
  const labels = (await tabs.allInnerTexts()).map((text) => text.trim().split("\n")[0]).filter(Boolean);
  for (const label of labels) {
    await tabs.filter({ hasText: label }).first().click().catch(() => undefined);
    await page.waitForTimeout(1100);
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
    await audit(`Painel › ${rotulo}${sufixo}`, null);

    // Segundo nível: os módulos do processo recém-aberto. Eles nascem com a
    // abertura, então precisam ser lidos agora, não antes.
    const modulos = page.locator('nav[aria-label="Navegação do painel"] .sidebar-process-view');
    const nomes = (await modulos.allInnerTexts()).map((text) => text.trim().split("\n")[0]).filter(Boolean);
    for (const nome of nomes.slice(1)) {
      await modulos.filter({ hasText: nome }).first().click().catch(() => undefined);
      await page.waitForTimeout(900);
      await audit(`Painel › ${rotulo} › ${nome}${sufixo}`, null);
      if (/Cadastros/u.test(nome)) {
        await auditSubTabs(`Painel › ${nome}${sufixo}`, 'main [class*="tabs"] > button, [class*="__tabs"] > button');
      }
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
async function switchTheme(target) {
  const label = target === "dark" ? /Usar tema escuro/u : /Usar tema claro/u;
  const toggle = page.getByRole("button", { name: label });
  if (await toggle.count() === 0) return false;
  await toggle.first().click();
  await page.waitForTimeout(700);
  return true;
}

async function auditEverything(theme) {
  console.log(`\n\n═══════════ TEMA ${theme.toUpperCase()} ═══════════`);
  await page.goto(`${BASE}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  // O padrão do produto é o escuro; o claro é que precisa ser pedido.
  if (theme === "light" && !await switchTheme("light")) {
    console.log("não foi possível ativar o tema claro");
    failures += 1;
    return;
  }
  await audit(`Painel [${theme}]`, null);
  await auditPanelViews(theme);
  await auditAssistant(theme);
  await audit(`Console da plataforma [${theme}]`, "/plataforma");
  await auditPlatformAreas(theme);
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
  }
}

try {
  await audit("Home pública", "/");
  await audit("Login", "/login");
  await audit("Painel", "/painel", async () => {
    await signIn();
    await page.goto(`${BASE}/painel`, { waitUntil: "domcontentloaded" });
  });
  // O tema fica no localStorage, então a escolha atravessa as navegações.
  await auditEverything("dark");
  await auditEverything("light");
  await switchTheme("dark");
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
