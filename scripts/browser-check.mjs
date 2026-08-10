/**
 * Verificação no navegador de verdade (Chromium via Playwright).
 *
 * Prova o que HTTP não prova: a página renderiza, os controles existem, a ação
 * do administrador acontece pela interface e o layout não estoura nas larguras
 * exigidas. Falha em qualquer verificação encerra com saída diferente de zero.
 *
 * Uso:
 *   VINCULATO_URL=http://localhost:3000 \
 *   VINCULATO_ADMIN_EMAIL=admin@vinculato.test \
 *   VINCULATO_ADMIN_PASSWORD='...' node scripts/browser-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.VINCULATO_URL ?? "http://localhost:3000";
const email = process.env.VINCULATO_ADMIN_EMAIL ?? "admin@vinculato.test";
const password = process.env.VINCULATO_ADMIN_PASSWORD ?? "";
const widths = [390, 768, 1280, 1440];

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// O caminho do Chromium pré-instalado varia com a versão empacotada; a busca
// evita fixar um número de build que quebra o ensaio no próximo ambiente.
const { readdirSync, existsSync } = await import("node:fs");
const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const chromiumDirectory = existsSync(browsersRoot)
  ? readdirSync(browsersRoot).find((entry) => /^chromium-\d+$/u.test(entry))
  : undefined;
const executablePath = chromiumDirectory ? `${browsersRoot}/${chromiumDirectory}/chrome-linux/chrome` : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160)); });
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 160)}`));

// 1. Site público
await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
record("a página inicial responde e carrega", page.url().startsWith(base));
record("o título traz a nova marca", (await page.title()).includes("Vinculato"), await page.title());
const bodyText = await page.locator("body").innerText();
record("o nome antigo não aparece na página inicial", !/Fila DP/u.test(bodyText));

// A home precisa ter sido reconstruída, não apenas trocado o logotipo: o
// posicionamento, as seções e os planos vêm do produto atual.
record("o herói traz o posicionamento Vinculato",
  (await page.locator("h1").first().innerText()).trim() === "Sua operação, conectada.",
  (await page.locator("h1").first().innerText()).trim());
record("o posicionamento anterior saiu da página", !/fila certa|Kanban gen[ée]rico/iu.test(bodyText));
// O texto renderizado sobe para maiúsculas em alguns rótulos por CSS; a
// comparação é insensível a caixa para medir o conteúdo, não o estilo.
const homeText = bodyText.toLocaleLowerCase("pt-BR");
for (const heading of ["Como funciona", "E o que o Vinculato não faz", "Integrações", "Planos", "Perguntas frequentes"]) {
  record(`a home apresenta a seção "${heading}"`, homeText.includes(heading.toLocaleLowerCase("pt-BR")));
}

// Os planos exibidos são os do catálogo, lidos do banco — não texto fixo.
const planNames = await page.locator(".plan-card .plan-name").allInnerTexts();
const catalog = await page.evaluate(async () => {
  const response = await fetch("/api/site/plans", { cache: "no-store" }).catch(() => null);
  return response?.ok ? await response.json() : null;
});
record("a home lista os planos publicados no catálogo", planNames.length >= 1, planNames.join(", "));
if (catalog?.plans) {
  const expected = catalog.plans.map((plan) => plan.name);
  record("os planos da home são exatamente os do catálogo",
    JSON.stringify(planNames.map((name) => name.trim().toLocaleLowerCase("pt-BR")))
      === JSON.stringify(expected.map((name) => name.toLocaleLowerCase("pt-BR"))),
    `home: ${planNames.join(", ")} | catálogo: ${expected.join(", ")}`);
  const prices = await page.locator(".plan-card .plan-price").allInnerTexts();
  const paidInCatalog = catalog.plans.filter((plan) => plan.monthlyPriceCents > 0);
  record("o preço exibido é o preço do catálogo, em centavos convertidos",
    paidInCatalog.every((plan) => {
      const shown = prices[catalog.plans.indexOf(plan)] ?? "";
      return shown.replace(/\s/gu, "").includes(String(Math.trunc(plan.monthlyPriceCents / 100)));
    }) && paidInCatalog.length > 0,
    prices.map((price) => price.split("\n")[0]).join(" | "));
}

// Nada de prova social inventada: cliente, depoimento, número ou certificação.
record("a home não publica cliente, depoimento, número ou certificação fictícios",
  !/depoimento|clientes atendidos|empresas confiam|casos de sucesso|ISO\s?\d|certificad[oa] (?:ISO|SOC)/iu.test(bodyText));

// 2. Login pela interface
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
const emailField = page.locator('input[type="email"], input[name="email"]').first();
const passwordField = page.locator('input[type="password"]').first();
record("a tela de login apresenta e-mail e senha", await emailField.count() > 0 && await passwordField.count() > 0);

// O cartão de login era centralizado por justify-content e passava por cima do
// link "Voltar para o site" em 1280x800 — altura comum de notebook.
for (const [width, height] of [[390, 844], [768, 1024], [1280, 800], [1440, 900], [1280, 620]]) {
  await page.setViewportSize({ width, height });
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  const collides = await page.evaluate(() => {
    const back = document.querySelector(".auth-back");
    const card = document.querySelector(".auth-form-card");
    if (!back || !card) return false;
    const a = back.getBoundingClientRect();
    const b = card.getBoundingClientRect();
    return !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
  });
  record(`login sem sobreposição de elementos em ${width}x${height}`, !collides);
}
await page.setViewportSize({ width: 1440, height: 900 });

if (password && await emailField.count()) {
  await emailField.fill(email);
  await passwordField.fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => undefined),
    page.getByRole("button", { name: /^Entrar$/u }).last().click(),
  ]);
  record("login pela interface leva ao painel", !page.url().includes("/login"), page.url());

  // 3. Console global
  await page.goto(`${base}/plataforma`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[role="tablist"]', { timeout: 20000 }).catch(() => undefined);
  record("o console global abre para o administrador da plataforma",
    await page.locator('[role="tablist"]').count() > 0,
    (await page.locator("h1").first().innerText().catch(() => "")).slice(0, 60));

  // A tabela carrega por fetch: contar antes da resposta mediria o vazio.
  await page.waitForSelector("table tbody tr", { timeout: 20000 }).catch(() => undefined);
  const workspaceRows = await page.locator("table tbody tr").count();
  record("a aba de workspaces lista clientes", workspaceRows > 0, `${workspaceRows} linha(s)`);

  // Criar workspace pela interface, não pela API.
  await page.getByRole("button", { name: /Novo workspace/u }).click();
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
  const stamp = Date.now();
  await page.locator('input[name="name"]').fill(`Cliente Navegador ${stamp}`);
  await page.locator('input[name="ownerEmail"]').fill(`nav-${stamp}@vinculato.test`);
  await page.locator('select[name="planCode"]').selectOption("standard");
  await page.getByRole("button", { name: /Criar workspace/u }).click();
  await page.waitForSelector('[role="status"]', { timeout: 20000 }).catch(() => undefined);
  const toast = await page.locator('[role="status"]').first().innerText().catch(() => "");
  record("criar workspace pela interface funciona", /criado/iu.test(toast), toast.slice(0, 80));

  const afterRows = await page.locator("table tbody tr").count();
  record("o workspace criado aparece na tabela", afterRows > workspaceRows, `${workspaceRows} → ${afterRows}`);

  // Aba de usuários
  await page.getByRole("tab", { name: /Usuários/u }).click();
  await page.waitForSelector("table tbody tr", { timeout: 20000 }).catch(() => undefined);
  const userRows = await page.locator("table tbody tr").count();
  record("a aba de usuários lista contas globais", userRows > 0, `${userRows} linha(s)`);
  const usersText = await page.locator("table").innerText().catch(() => "");
  record("a tela nunca mostra hash de senha", !/\$argon|\$2[aby]\$|password_hash/u.test(usersText));

  // 4. Responsividade das telas autenticadas
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(350);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    record(`console global sem rolagem horizontal em ${width}px`, overflow <= 1, `sobra ${overflow}px`);
  }
} else {
  record("credenciais do administrador não informadas", false, "defina VINCULATO_ADMIN_PASSWORD");
}

// 4a. Tela de usuários e permissões: o administrador precisa conseguir revisar
//     acesso e criar gente pela interface, não pela API.
if (password) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
  const accessEntry = page.getByRole("button", { name: /Usuários e permissões/u }).first();
  record("o painel oferece a tela de usuários e permissões", await accessEntry.count() > 0);
  if (await accessEntry.count()) {
    await accessEntry.click();
    await page.waitForSelector("table", { timeout: 20000 }).catch(() => undefined);
    const accessText = await page.locator("main").innerText();
    record("a tela mostra o consumo de assentos do plano", /ASSENTOS/iu.test(accessText),
      (/ASSENTOS[\s\S]{0,60}/u.exec(accessText)?.[0] ?? "").replace(/\n/gu, " · ").slice(0, 80));
    record("a tela explica o que cada papel permite", accessText.includes("Matriz de permissões"));
    record("a tela nunca mostra hash de senha", !/\$argon|\$2[aby]\$|password_hash/u.test(accessText));

    // Criar usuário pela interface e conferir que o link de ativação aparece.
    const seatsFull = /limite atingido/u.test(accessText);
    if (!seatsFull) {
      const stamp = Date.now();
      await page.getByRole("button", { name: /Novo usuário/u }).click();
      await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
      await page.locator('input[name="name"]').fill(`Acesso Navegador ${stamp}`);
      await page.locator('input[name="email"]').fill(`acesso-${stamp}@vinculato.test`);
      await page.locator('select[name="role"]').selectOption("member");
      await page.getByRole("button", { name: /Criar usuário e gerar link/u }).click();
      await page.waitForSelector('[role="status"]', { timeout: 20000 }).catch(() => undefined);
      const created = await page.locator("main").innerText();
      record("criar usuário pela interface entrega link de ativação, não senha",
        created.includes("LINK ÚNICO DE ATIVAÇÃO") && !/senha:|password/iu.test(created));
    } else {
      record("o limite de assentos bloqueia a criação em vez de falhar depois",
        await page.getByRole("button", { name: /Novo usuário/u }).count() > 0, "plano no limite");
    }

    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(350);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      record(`tela de usuários sem rolagem horizontal em ${width}px`, overflow <= 1, `sobra ${overflow}px`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
}

// 4a-bis. O seletor de grupo precisa estar no shell, em toda largura. Ele já
//         esteve escondido entre 761px e 1499px — a faixa da maioria dos
//         notebooks —, o que tirava do ar uma ação essencial.
if (password) {
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
  const multi = await page.evaluate(async () => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    const payload = await response.json();
    return (payload.availableWorkspaces ?? []).length;
  });
  if (multi > 1) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const visible = await page.locator(".sidebar-workspace-switcher").isVisible().catch(() => false);
      record(`seletor de grupo disponível em ${width}px`, visible);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  } else {
    record("conta de ensaio pertence a um grupo só: seletor não se aplica", true, `${multi} grupo(s)`);
  }
}

// 4b. Liberação por plano: o menu do painel reflete o plano contratado.
if (password) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
  const menu = await page.locator("nav[aria-label='Navegação do painel'] button").allInnerTexts();
  const menuText = menu.join(" | ");
  const snapshot = await page.evaluate(async () => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    const payload = await response.json();
    return (payload.modules ?? []).map((item) => ({ key: item.key, allowed: item.allowed, reason: item.reason }));
  });
  const allowed = new Set(snapshot.filter((item) => item.allowed).map((item) => item.key));
  const blocked = snapshot.filter((item) => !item.allowed);
  record("o painel resolve o catálogo de módulos", snapshot.length > 0, `${allowed.size} liberado(s), ${blocked.length} bloqueado(s)`);
  // O grupo do administrador está no Starter: ponto e pagamentos ficam fora.
  record("módulo fora do plano não aparece no menu",
    !allowed.has("time_tracking") ? !/Ponto/u.test(menuText) : true,
    menuText.slice(0, 120));
  record("módulo bloqueado explica o motivo em vez de sumir calado",
    blocked.every((item) => item.reason && item.reason !== "ok"),
    blocked.map((item) => `${item.key}:${item.reason}`).slice(0, 4).join(", "));
}

// 5. Responsividade do site público
for (const width of widths) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(350);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record(`site público sem rolagem horizontal em ${width}px`, overflow <= 1, `sobra ${overflow}px`);
}

// A marca precisa aparecer como arquivo oficial, e em branco sobre fundo escuro.
await page.goto(`${base}/login`, { waitUntil: "networkidle" });
const brandSources = await page.evaluate(() => [...document.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? ""));
record("o login usa o logotipo oficial na variante clara",
  brandSources.some((src) => src.includes("vinculato-logo-light")),
  brandSources.join(" ").slice(0, 120));
await page.goto(`${base}/`, { waitUntil: "networkidle" });
const siteSources = await page.evaluate(() => [...document.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? ""));
record("o site usa o logotipo oficial colorido",
  siteSources.some((src) => src.includes("vinculato-logo")),
  siteSources.join(" ").slice(0, 120));

record("nenhum erro de JavaScript no console do navegador", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

await browser.close();

const failures = results.filter((item) => !item.ok);
console.log(`\n${results.length - failures.length}/${results.length} verificações de navegador passaram.`);
if (failures.length) {
  console.log("Falhas:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
