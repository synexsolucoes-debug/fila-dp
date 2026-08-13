import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import { parseSankhyaExport } from "../../lib/sankhya/files.ts";
import { SankhyaConnectorError } from "../../lib/sankhya/errors.ts";
import { assertPublicNavigationUrl } from "../../lib/sankhya/navigation-security.ts";
import { SankhyaSelectors } from "../../lib/sankhya/selectors.ts";
import type { SankhyaBrowserSession, SankhyaConfig, SankhyaCredentials, SankhyaExtraction } from "../../lib/sankhya/types.ts";

async function visible(locator: Locator) {
  return locator.first().isVisible().catch(() => false);
}

async function firstVisible(locators: Locator[]) {
  for (const locator of locators) if (await visible(locator)) return locator.first();
  return null;
}

function frameLocators(page: Page, factory: (frame: Frame) => Locator[]) {
  return page.frames().flatMap(factory);
}

async function bodyText(page: Page) {
  return (await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "")).slice(0, 50_000);
}

function hasAny(source: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(source));
}

async function waitUntil(page: Page, predicate: () => Promise<boolean>, timeoutMs: number, code: string, message: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.waitForTimeout(250);
  }
  throw new SankhyaConnectorError(code, message, { retryable: code.includes("TIMEOUT") });
}

export class PlaywrightSankhyaSession implements SankhyaBrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private directory = "";
  private validatedOrigins = new Map<string, number>();

  static async create() {
    const session = new PlaywrightSankhyaSession();
    session.directory = await mkdtemp(join(tmpdir(), "vinculato-sankhya-"));
    session.browser = await chromium.launch({
      headless: true,
      chromiumSandbox: process.env.FDP_SANKHYA_CHROMIUM_SANDBOX === "true",
      args: ["--disable-dev-shm-usage"],
    });
    session.context = await session.browser.newContext({ acceptDownloads: true, locale: "pt-BR", timezoneId: "America/Sao_Paulo", serviceWorkers: "block" });
    session.page = await session.context.newPage();
    await session.context.route("**/*", async (route) => {
      try {
        const url = new URL(route.request().url());
        if (!["https:", "data:", "blob:", "about:"].includes(url.protocol)) return route.abort("blockedbyclient");
        const validatedAt = session.validatedOrigins.get(url.origin) ?? 0;
        if (url.protocol === "https:" && Date.now() - validatedAt > 30_000) {
          await assertPublicNavigationUrl(url.toString());
          session.validatedOrigins.set(url.origin, Date.now());
        }
        return route.continue();
      } catch { return route.abort("blockedbyclient"); }
    });
    await session.context.routeWebSocket("**/*", async (webSocket) => {
      try {
        const target = new URL(webSocket.url());
        if (target.protocol !== "wss:") throw new Error("WebSocket inseguro");
        target.protocol = "https:";
        await assertPublicNavigationUrl(target.toString());
        webSocket.connectToServer();
      } catch { await webSocket.close({ code: 1008, reason: "Destino bloqueado" }); }
    });
    return session;
  }

  private requiredPage() {
    if (!this.page) throw new SankhyaConnectorError("SANKHYA_SESSION_CLOSED", "A sessão do navegador já foi encerrada.");
    return this.page;
  }

  async authenticate(endpoint: string, credentials: SankhyaCredentials, timeoutMs: number) {
    const page = this.requiredPage();
    await assertPublicNavigationUrl(endpoint);
    try { await page.goto(endpoint, { waitUntil: "domcontentloaded", timeout: timeoutMs }); }
    catch { throw new SankhyaConnectorError("SANKHYA_UNAVAILABLE", "O ambiente Sankhya está indisponível ou demorou para responder.", { retryable: true }); }
    let source = await bodyText(page);
    this.throwForInteractiveAuth(source);
    const username = await firstVisible([
      ...frameLocators(page, (frame) => SankhyaSelectors.usernameLabels.map((label) => frame.getByLabel(label))),
      ...frameLocators(page, (frame) => SankhyaSelectors.usernameCss.map((selector) => frame.locator(selector))),
    ]);
    const password = await firstVisible([
      ...frameLocators(page, (frame) => SankhyaSelectors.passwordLabels.map((label) => frame.getByLabel(label))),
      ...frameLocators(page, (frame) => SankhyaSelectors.passwordCss.map((selector) => frame.locator(selector))),
    ]);
    if (!username || !password) {
      if (hasAny(source, SankhyaSelectors.authenticatedMarkers) || hasAny(source, SankhyaSelectors.dpExplorer)) return;
      throw new SankhyaConnectorError("SELECTOR_NOT_FOUND", "A tela de login do Sankhya mudou e os campos não foram localizados.", { layoutRelated: true });
    }
    await username.fill(credentials.username);
    await password.fill(credentials.password);
    const login = await firstVisible(frameLocators(page, (frame) => SankhyaSelectors.loginButtons.flatMap((name) => [
      frame.getByRole("button", { name }), frame.getByRole("link", { name }),
    ])));
    if (!login) throw new SankhyaConnectorError("SELECTOR_NOT_FOUND", "O botão de login do Sankhya não foi localizado.", { layoutRelated: true });
    await login.click();
    await waitUntil(page, async () => {
      source = await bodyText(page);
      this.throwForInteractiveAuth(source);
      if (hasAny(source, SankhyaSelectors.invalidLoginMarkers)) throw new SankhyaConnectorError("SANKHYA_LOGIN_INVALID", "Login inválido.");
      if (hasAny(source, SankhyaSelectors.blockedMarkers)) throw new SankhyaConnectorError("SANKHYA_USER_BLOCKED", "Usuário Sankhya bloqueado.", { requiresUserAction: true });
      if (hasAny(source, SankhyaSelectors.expiredPasswordMarkers)) throw new SankhyaConnectorError("SANKHYA_PASSWORD_EXPIRED", "A senha do usuário Sankhya expirou.", { requiresUserAction: true });
      const passwordStillVisible = await visible(password);
      return hasAny(source, SankhyaSelectors.authenticatedMarkers) || hasAny(source, SankhyaSelectors.dpExplorer) || !passwordStillVisible;
    }, timeoutMs, "SANKHYA_LOGIN_TIMEOUT", "O login do Sankhya não foi concluído no tempo esperado.");
  }

  private throwForInteractiveAuth(source: string) {
    if (hasAny(source, SankhyaSelectors.captchaMarkers)) throw new SankhyaConnectorError("SANKHYA_CAPTCHA_REQUIRED", "O Sankhya exige CAPTCHA e precisa de intervenção humana.", { requiresUserAction: true });
    if (hasAny(source, SankhyaSelectors.mfaMarkers)) throw new SankhyaConnectorError("SANKHYA_MFA_REQUIRED", "O Sankhya exige autenticação adicional e precisa de intervenção humana.", { requiresUserAction: true });
  }

  async openDpExplorer(config: SankhyaConfig) {
    const page = this.requiredPage();
    let target = await firstVisible(frameLocators(page, (frame) => SankhyaSelectors.dpExplorer.flatMap((name) => [
      frame.getByRole("link", { name }), frame.getByRole("button", { name }), frame.getByRole("menuitem", { name }), frame.getByText(name, { exact: true }),
    ])));
    if (!target) {
      const search = await firstVisible(frameLocators(page, (frame) => SankhyaSelectors.searchLabels.map((label) => frame.getByLabel(label))));
      if (search) {
        await search.fill(config.routineName);
        target = await firstVisible(frameLocators(page, (frame) => SankhyaSelectors.dpExplorer.flatMap((name) => [frame.getByText(name, { exact: true }), frame.getByRole("option", { name })])));
      }
    }
    if (!target) throw new SankhyaConnectorError("DP_EXPLORER_NOT_FOUND", "Usuário sem acesso ao DP Explorer ou interface alterada.", { layoutRelated: true });
    await target.click();
    await waitUntil(page, async () => {
      const source = await bodyText(page);
      return hasAny(source, SankhyaSelectors.executeButtons) || (await firstVisible(frameLocators(page, (frame) => [frame.locator("table"), frame.getByRole("grid")])) !== null);
    }, config.timeoutMs, "DP_EXPLORER_TIMEOUT", "O DP Explorer não terminou de carregar.");
  }

  async runRoutine(config: SankhyaConfig) {
    const page = this.requiredPage();
    if (config.companyContext) {
      const company = await firstVisible(frameLocators(page, (frame) => [frame.getByLabel(/empresa|contexto/iu), frame.getByRole("combobox", { name: /empresa|contexto/iu })]));
      if (company) {
        await company.selectOption({ label: config.companyContext }).catch(() => company.fill(config.companyContext));
      }
    }
    const execute = await firstVisible(frameLocators(page, (frame) => SankhyaSelectors.executeButtons.map((name) => frame.getByRole("button", { name }))));
    if (!execute) throw new SankhyaConnectorError("SELECTOR_NOT_FOUND", "O comando de executar/atualizar do DP Explorer não foi localizado.", { layoutRelated: true });
    await execute.click();
    await waitUntil(page, async () => {
      const source = await bodyText(page);
      if (hasAny(source, SankhyaSelectors.errorMarkers)) throw new SankhyaConnectorError("SANKHYA_ROUTINE_FAILED", "O DP Explorer informou erro ao executar a consulta.");
      const loading = hasAny(source, SankhyaSelectors.loadingMarkers);
      const result = await firstVisible(frameLocators(page, (frame) => [frame.locator("table"), frame.getByRole("grid"), ...SankhyaSelectors.exportButtons.map((name) => frame.getByRole("button", { name }))]));
      return !loading && Boolean(result);
    }, config.timeoutMs, "SANKHYA_ROUTINE_TIMEOUT", "A consulta do DP Explorer excedeu o tempo configurado.");
  }

  async extract(config: SankhyaConfig): Promise<SankhyaExtraction> {
    const page = this.requiredPage();
    const exportButton = await firstVisible(frameLocators(page, (frame) => SankhyaSelectors.exportButtons.flatMap((name) => [
      frame.getByRole("button", { name }), frame.getByRole("menuitem", { name }), frame.getByText(name, { exact: true }),
    ])));
    if (exportButton) {
      try {
        const downloadPromise = page.waitForEvent("download", { timeout: Math.min(config.timeoutMs, 30_000) });
        await exportButton.click();
        const format = await firstVisible(frameLocators(page, (frame) => [/xlsx/iu, /excel/iu, /csv/iu].map((name) => frame.getByRole("menuitem", { name }))));
        if (format) await format.click();
        const download = await downloadPromise;
        const suggested = download.suggestedFilename();
        const extension = extname(suggested).toLowerCase();
        if (![".xlsx", ".csv"].includes(extension)) throw new SankhyaConnectorError("SANKHYA_EXPORT_TYPE_INVALID", "A exportação não gerou XLSX ou CSV.");
        const saved = join(this.directory, `${crypto.randomUUID()}${extension}`);
        await download.saveAs(saved);
        const records = await parseSankhyaExport(saved, suggested, config.downloadLimitBytes);
        return { records, source: extension === ".csv" ? "csv" : "xlsx" };
      } catch (error) {
        if (error instanceof SankhyaConnectorError) throw error;
        // Alguns ambientes não oferecem download confiável; a tabela é o fallback explícito.
      }
    }
    for (const frame of page.frames()) {
      const table = await firstVisible([frame.locator("table"), frame.getByRole("grid")]);
      if (!table) continue;
      const headers = (await table.locator("thead th").allTextContents()).map((item) => item.trim());
      const rows = table.locator("tbody tr");
      const count = await rows.count();
      if (!headers.length || !count) continue;
      const records: Record<string, unknown>[] = [];
      for (let index = 0; index < Math.min(count, 10_000); index += 1) {
        const cells = await rows.nth(index).locator("td").allTextContents();
        records.push(Object.fromEntries(headers.map((header, cell) => [header, cells[cell]?.trim() ?? ""])));
      }
      return { records, source: "table" };
    }
    throw new SankhyaConnectorError("SANKHYA_RESULTS_NOT_FOUND", "A consulta terminou, mas nenhum resultado estruturado foi localizado.", { layoutRelated: true });
  }

  async diagnosticScreenshot() {
    if (!this.page || this.page.isClosed()) return null;
    const bytes = await this.page.screenshot({ type: "png", fullPage: false, animations: "disabled",
      mask: [this.page.locator('input[type="password"]')],
      style: "input, textarea, tbody td { filter: blur(7px) !important; }" });
    return { bytes: Buffer.from(bytes), mimeType: "image/png" as const };
  }

  async logout() {
    if (!this.page || this.page.isClosed()) return;
    const logout = await firstVisible(frameLocators(this.page, (frame) => SankhyaSelectors.logoutButtons.flatMap((name) => [frame.getByRole("button", { name }), frame.getByRole("menuitem", { name }), frame.getByText(name, { exact: true })])));
    if (logout) await logout.click({ timeout: 5_000 }).catch(() => undefined);
    await this.context?.clearCookies();
    for (const page of this.context?.pages() ?? []) {
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => undefined);
    }
  }

  async close() {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    if (this.directory) await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
    this.page = null; this.context = null; this.browser = null; this.directory = "";
  }
}
