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

// 2. Login pela interface
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
const emailField = page.locator('input[type="email"], input[name="email"]').first();
const passwordField = page.locator('input[type="password"]').first();
record("a tela de login apresenta e-mail e senha", await emailField.count() > 0 && await passwordField.count() > 0);

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
  await page.waitForTimeout(1200);
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

// 5. Responsividade do site público
for (const width of widths) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(350);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record(`site público sem rolagem horizontal em ${width}px`, overflow <= 1, `sobra ${overflow}px`);
}

record("nenhum erro de JavaScript no console do navegador", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

await browser.close();

const failures = results.filter((item) => !item.ok);
console.log(`\n${results.length - failures.length}/${results.length} verificações de navegador passaram.`);
if (failures.length) {
  console.log("Falhas:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
