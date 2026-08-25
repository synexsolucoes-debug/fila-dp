import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { tangerinoAgentConfig } from "../../lib/tangerino/config.ts";
import { tangerinoErrors, TangerinoAgentError } from "../../lib/tangerino/errors.ts";
import { tangerinoAdmissionsOverviewUrl } from "../../lib/tangerino/hosts.ts";
import { assertAllowedTangerinoChallengeUrl, assertAllowedTangerinoUrl } from "../../lib/tangerino/navigation-security.ts";
import { log } from "../../lib/observability.ts";
import { readOnlyDecision, readOnlyViolationDetail } from "../../lib/tangerino/read-only.ts";
import { TangerinoSelectors } from "../../lib/tangerino/selectors.ts";
import type { AdmissionSearchHit, AdmissionSnapshot, TangerinoArtifactSession } from "../../lib/tangerino/types.ts";

/**
 * O cliente de navegador do Tangerino.
 *
 * Implementa exatamente os sete comandos do contrato e nenhum a mais. Cada um
 * deles ou encontra o que procura, ou falha com `UI_CHANGED` dizendo qual etapa
 * e qual elemento — nunca segue adiante com "achei alguma coisa parecida",
 * porque o resultado disso seria um status lido do campo errado, e um status
 * errado é acreditado.
 *
 * Os seletores críticos foram confirmados contra a interface real em 24/08/2026
 * (§72). A lista de admissões é um aplicativo dentro de iframe; os resultados
 * são cartões e já trazem situação e etapa. O agente seleciona um cartão em
 * memória e não clica nos botões de ação dele.
 */

type TangerinoLocatorScope = Pick<Page, "getByLabel" | "getByPlaceholder" | "getByRole" | "getByText" | "locator">;

async function isVisible(locator: Locator) {
  return locator.first().isVisible({ timeout: 1_500 }).catch(() => false);
}

async function firstVisible(locators: Locator[]) {
  for (const locator of locators) if (await isVisible(locator)) return locator.first();
  return null;
}

async function bodyText(scope: TangerinoLocatorScope) {
  return (await scope.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 40_000);
}

function hasAny(source: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(source));
}

/**
 * Lê o valor ao lado de um rótulo.
 *
 * Telas de sistema quase sempre põem rótulo e valor no mesmo contêiner. Tentar
 * `getByLabel` primeiro cobre o caso semântico (campo de formulário); o passo
 * seguinte cobre o caso de exibição, subindo um nível a partir do texto do
 * rótulo e tirando o próprio rótulo do que sobrou. É frágil por natureza — por
 * isso devolve `undefined` em vez de chutar, e quem chama decide se a ausência é
 * tolerável ou é `UI_CHANGED`.
 */
export async function readLabeledValue(page: TangerinoLocatorScope, labels: readonly RegExp[]): Promise<string | undefined> {
  for (const label of labels) {
    const field = page.getByLabel(label).first();
    if (await isVisible(field)) {
      const value = await field.inputValue().catch(() => field.innerText().catch(() => ""));
      if (value && value.trim()) return value.trim();
    }
  }
  for (const label of labels) {
    const marker = page.getByText(label).first();
    if (!await isVisible(marker)) continue;
    const text = (await marker.locator("xpath=..").innerText().catch(() => "")).trim();
    const stripped = text.replace(label, "").replace(/^[\s:–—-]+/u, "").trim();
    if (stripped && stripped.length <= 400) return stripped;
  }
  for (const label of labels) {
    const holder = page.locator("dl,tr,li,div,section").filter({ hasText: label }).last();
    if (!await isVisible(holder)) continue;
    const text = (await holder.innerText().catch(() => "")).trim();
    if (!text) continue;
    const stripped = text.replace(label, "").replace(/^[\s:–—-]+/u, "").trim();
    if (stripped && stripped.length <= 400) return stripped;
  }
  return undefined;
}

/** Lê o `p.info-status` que está no mesmo bloco do rótulo do cartão. */
async function readCardValue(card: Locator, labels: readonly RegExp[]): Promise<string | undefined> {
  for (const label of labels) {
    const marker = card.getByText(label).first();
    if (!await isVisible(marker)) continue;
    const value = marker.locator("xpath=..").locator(TangerinoSelectors.cardValueCss).first();
    if (!await isVisible(value)) continue;
    const text = (await value.innerText().catch(() => "")).trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * A barreira de autenticação que a página apresenta, se houver.
 *
 * Exportada porque é a decisão mais fácil de errar em silêncio: confundir a tela
 * de MFA com a de login faria o agente digitar a senha num campo de código de
 * verificação, e repetir isso bloqueia a conta do cliente. A verificação por
 * fixture exercita esta função diretamente.
 */
export function detectAuthBarrier(text: string, captchaWidgetPresent = false): "mfa" | "captcha" | "denied" | "login" | null {
  if (hasAny(text, TangerinoSelectors.mfaMarkers)) return "mfa";
  // O widget vale tanto quanto a palavra: a tela de desafio costuma trazer o
  // iframe e o texto de login juntos, e ler "login" ali faria o agente digitar
  // a senha no meio de um CAPTCHA.
  if (captchaWidgetPresent || hasAny(text, TangerinoSelectors.captchaMarkers)) return "captcha";
  if (hasAny(text, TangerinoSelectors.accessDeniedMarkers)) return "denied";
  if (hasAny(text, TangerinoSelectors.loginMarkers) || hasAny(text, TangerinoSelectors.sessionExpiredMarkers)) return "login";
  return null;
}

/** O desafio existe no DOM mesmo quando a página não escreve a palavra. */
export async function hasCaptchaWidget(page: Page) {
  for (const selector of TangerinoSelectors.captchaWidgets) {
    if (await page.locator(selector).count().catch(() => 0)) return true;
  }
  return false;
}

/**
 * Um diretório opaco por workspace. O identificador do cliente não aparece no
 * disco e, principalmente, dois workspaces nunca compartilham cookies.
 */
export function tangerinoProfileDirectory(profileRoot: string, workspaceId: string) {
  const root = resolve(profileRoot.trim());
  const tenant = workspaceId.trim();
  if (!profileRoot.trim() || !tenant) throw new Error("Perfil persistente exige raiz e workspace.");
  const opaqueId = createHash("sha256").update(tenant).digest("hex").slice(0, 32);
  return join(root, opaqueId);
}

/** Lê um cartão real sem abrir ficha, documentos ou qualquer ação de edição. */
export async function readAdmissionCard(card: Locator): Promise<AdmissionSnapshot> {
  const title = card.locator(TangerinoSelectors.resultNameCss).first();
  const displayName = await title.getAttribute("title").catch(() => null)
    ?? await title.innerText().catch(() => "");
  return {
    // A interface mapeada não expõe protocolo nem data efetiva no cartão.
    externalAdmissionId: await card.getAttribute("data-id").catch(() => null)
      ?? await card.getAttribute("id").catch(() => null)
      ?? undefined,
    rawStatus: await readCardValue(card, TangerinoSelectors.statusLabels),
    stage: await readCardValue(card, TangerinoSelectors.stageLabels),
    pendingReason: await readLabeledValue(card, TangerinoSelectors.pendingLabels),
    admissionDate: await readLabeledValue(card, TangerinoSelectors.admissionDateLabels),
    sourceUpdatedAt: await readLabeledValue(card, TangerinoSelectors.updatedAtLabels),
    displayName: displayName.trim() || undefined,
  };
}

/** Lê uma página de fixture ou, quando presente, seu primeiro cartão realista. */
export async function readAdmissionFrom(page: TangerinoLocatorScope): Promise<AdmissionSnapshot> {
  const card = page.locator(TangerinoSelectors.resultCardCss).first();
  if (await isVisible(card)) return readAdmissionCard(card);
  return {
    externalAdmissionId: await readLabeledValue(page, TangerinoSelectors.externalIdLabels),
    rawStatus: await readLabeledValue(page, TangerinoSelectors.statusLabels),
    stage: await readLabeledValue(page, TangerinoSelectors.stageLabels),
    pendingReason: await readLabeledValue(page, TangerinoSelectors.pendingLabels),
    admissionDate: await readLabeledValue(page, TangerinoSelectors.admissionDateLabels),
    sourceUpdatedAt: await readLabeledValue(page, TangerinoSelectors.updatedAtLabels),
    displayName: await readLabeledValue(page, TangerinoSelectors.displayNameLabels),
  };
}

/** Coleta os cartões do resultado, sem escolher nenhum. */
export async function collectSearchHits(page: TangerinoLocatorScope): Promise<AdmissionSearchHit[]> {
  const text = await bodyText(page);
  if (hasAny(text, TangerinoSelectors.emptyResultMarkers)) return [];
  const cards = page.locator(TangerinoSelectors.resultCardCss);
  const total = await cards.count().catch(() => 0);
  const hits: AdmissionSearchHit[] = [];
  // Teto de leitura: o que interessa é "um ou mais de um". Percorrer duzentas
  // linhas para depois recusar por duplicidade seria gastar tempo à toa.
  for (let index = 0; index < Math.min(total, 25); index += 1) {
    const card = cards.nth(index);
    const name = card.locator(TangerinoSelectors.resultNameCss).first();
    const label = ((await name.getAttribute("title").catch(() => null))
      ?? (await name.innerText().catch(() => ""))).replace(/\s+/gu, " ").trim();
    if (!label) continue;
    const id = (await card.getAttribute("data-id").catch(() => null))
      ?? (await card.getAttribute("id").catch(() => null))
      ?? `card:${index}`;
    hits.push({ id: id.slice(0, 120), label: label.slice(0, 200) });
  }
  return hits;
}

export class PlaywrightTangerinoSession implements TangerinoArtifactSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private admissionsFrame: TangerinoLocatorScope | null = null;
  private selectedAdmissionCard: Locator | null = null;
  private directAdmission = false;
  private persistentProfile = false;
  private authenticatedAt = 0;
  /** Requisições de alteração que a página tentou. Só método e caminho. */
  readonly blockedWrites: Array<{ method: string; path: string }> = [];

  static async create(options: { workspaceId?: string } = {}) {
    const config = tangerinoAgentConfig();
    const session = new PlaywrightTangerinoSession();
    const browserOptions = {
      headless: config.headless,
      chromiumSandbox: process.env.FDP_TANGERINO_CHROMIUM_SANDBOX === "true",
      args: ["--disable-dev-shm-usage"],
    };
    const contextOptions = {
      acceptDownloads: true,
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      serviceWorkers: "block",
    } as const;
    if (config.profileRoot) {
      if (!options.workspaceId) {
        throw tangerinoErrors.unavailable("O worker persistente não recebeu o workspace do perfil.");
      }
      const profileDirectory = tangerinoProfileDirectory(config.profileRoot, options.workspaceId);
      await mkdir(profileDirectory, { recursive: true });
      session.context = await chromium.launchPersistentContext(profileDirectory, {
        ...browserOptions,
        ...contextOptions,
      });
      session.browser = session.context.browser();
      session.persistentProfile = true;
    } else {
      session.browser = await chromium.launch(browserOptions);
      /* O runner efêmero continua com contexto novo por consulta. O modo
         persistente só existe quando uma raiz foi configurada e então usa um
         diretório diferente para cada workspace. */
      session.context = await session.browser.newContext(contextOptions);
    }
    session.page = session.context.pages()[0] ?? await session.context.newPage();
    session.page.setDefaultTimeout(Math.min(30_000, config.timeoutMs));

    await session.context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      let interactiveChallengeResource = false;
      try {
        await assertAllowedTangerinoUrl(url);
      } catch (error) {
        if (config.interactiveAuth) {
          interactiveChallengeResource = await assertAllowedTangerinoChallengeUrl(url)
            .then(() => true).catch(() => false);
        }
        if (interactiveChallengeResource && request.isNavigationRequest()
            && request.frame() === session.page?.mainFrame()) {
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        if (interactiveChallengeResource) {
          await route.continue().catch(() => undefined);
          return;
        }
        // Recurso de terceiro (fonte, telemetria) é apenas abortado; o que
        // interrompe a consulta é a *navegação* sair do domínio, tratada abaixo.
        if (request.isNavigationRequest() && error instanceof TangerinoAgentError) throw error;
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      const decision = readOnlyDecision({ method: request.method(), url, body: request.postData() ?? undefined });
      if (decision === "block") {
        session.blockedWrites.push(readOnlyViolationDetail({ method: request.method(), url }));
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });

    /* Redirecionamento para fora do domínio é interrupção, não aviso (§22).
       Uma sessão autenticada que segue redirect cego é a credencial do cliente
       sendo levada a um servidor que ninguém autorizou. */
    session.page.on("framenavigated", (frame) => {
      if (frame !== session.page?.mainFrame()) return;
      void assertAllowedTangerinoUrl(frame.url()).catch(() => undefined);
    });
    return session;
  }

  private requirePage() {
    if (!this.page) throw tangerinoErrors.unavailable("A sessão do navegador não está aberta.");
    return this.page;
  }

  private async resolveAdmissionsFrame(timeoutMs: number) {
    const page = this.requirePage();
    const deadline = Date.now() + timeoutMs;
    do {
      const pageIsAdmissionsApp = (() => {
        try { return new URL(page.url()).hostname === "admissao-demissao.tangerino.com.br"; }
        catch { return false; }
      })();
      if (pageIsAdmissionsApp && await isVisible(page.locator("body"))) {
        const pageMarker = await firstVisible(TangerinoSelectors.admissionsPageMarkers.map((text) => page.getByText(text)));
        const searchField = await firstVisible(TangerinoSelectors.searchPlaceholders.map((text) => page.getByPlaceholder(text)));
        if (pageMarker && searchField) return page;
      }
      const preferred = page.locator(TangerinoSelectors.admissionsFrameCss);
      const allFrames = page.locator("iframe");
      for (const candidates of [preferred, allFrames]) {
        const total = Math.min(await candidates.count().catch(() => 0), 25);
        for (let index = 0; index < total; index += 1) {
          const iframe = candidates.nth(index);
          const frame = iframe.contentFrame();
          const body = frame.locator("body");
          if (!await isVisible(body)) continue;
          const marker = await firstVisible(TangerinoSelectors.admissionsPageMarkers.map((text) => frame.getByText(text)));
          if (marker) return frame;

          /* Classes e rótulos do shell mudam; a origem do produto não. Um
             iframe oficial já é um candidato seguro e a próxima etapa ainda
             exige o campo de pesquisa exato antes de digitar qualquer coisa. */
          const source = await iframe.getAttribute("src").catch(() => null);
          const handle = await iframe.elementHandle().catch(() => null);
          const content = await handle?.contentFrame().catch(() => null);
          const urls = [source ? new URL(source, page.url()).toString() : "", content?.url() ?? ""];
          if (urls.some((raw) => {
            try { return new URL(raw).hostname === "admissao-demissao.tangerino.com.br"; }
            catch { return false; }
          })) return frame;
        }
      }
      await page.waitForTimeout(250);
    } while (Date.now() < deadline);

    const pagePath = (() => { try { return new URL(page.url()).pathname; } catch { return ""; } })();
    log("warn", "tangerino.admissions_frame_not_found", {}, {
      iframeCount: await page.locator("iframe").count().catch(() => 0), pagePath,
    });
    return null;
  }

  private requireAdmissionsFrame() {
    if (!this.admissionsFrame) {
      throw tangerinoErrors.uiChanged("leitura da Admissão", "iframe da lista de admissões");
    }
    return this.admissionsFrame;
  }

  /** Sessão ainda válida dentro da janela configurada (§13, §14). */
  private sessionIsFresh() {
    return this.authenticatedAt > 0 && Date.now() - this.authenticatedAt < tangerinoAgentConfig().sessionTtlMs;
  }

  private async currentAuthBarrier() {
    const page = this.requirePage();
    const text = await bodyText(page);
    /* Alguns SPAs mantêm o DOM antigo escondido depois do login. Um iframe de
       CAPTCHA invisível não pode prender para sempre uma tela que já mostra os
       marcadores autenticados e não mostra mais o formulário de acesso. */
    if (hasAny(text, TangerinoSelectors.authenticatedMarkers)
        && !hasAny(text, [...TangerinoSelectors.loginMarkers, ...TangerinoSelectors.sessionExpiredMarkers])) {
      return null;
    }
    return detectAuthBarrier(text, await hasCaptchaWidget(page));
  }

  /**
   * Aguarda uma pessoa concluir o desafio na janela visível. Não clica, não
   * preenche e não chama serviço de resolução: a única ação do agente é esperar
   * a navegação legítima terminar e então reutilizar a sessão resultante.
   */
  private async waitForManualAuthentication(barrier: "mfa" | "captcha") {
    const config = tangerinoAgentConfig();
    if (!config.interactiveAuth) {
      const label = barrier === "captcha" ? "um CAPTCHA" : "autenticação em duas etapas";
      throw tangerinoErrors.authenticationRequired(`O Tangerino pediu ${label}. Renove o acesso manualmente em um worker interativo.`);
    }
    log("warn", "tangerino.interactive_auth_waiting", {}, {
      barrier,
      timeoutMs: config.interactiveAuthTimeoutMs,
    });
    const deadline = Date.now() + config.interactiveAuthTimeoutMs;
    while (Date.now() < deadline) {
      await this.requirePage().waitForTimeout(1_000);
      const current = await this.currentAuthBarrier();
      if (current !== "mfa" && current !== "captcha") return current;
    }
    throw tangerinoErrors.authenticationRequired("O tempo para concluir a autenticação manual terminou. Inicie um novo teste quando puder acompanhar a janela.");
  }

  /**
   * Garante sessão — e só aguarda barreira humana no worker visível autorizado.
   *
   * No runner efêmero, MFA e CAPTCHA devolvem `AUTHENTICATION_REQUIRED`. No
   * worker Windows, a pessoa conclui o desafio na própria janela; o agente não
   * tenta resolver, contornar nem clicar no mecanismo de segurança.
   */
  async ensureAuthenticated(input: { endpoint: string; username: string; password: string; timeoutMs: number }) {
    const page = this.requirePage();
    if (this.sessionIsFresh()) return;
    const url = await assertAllowedTangerinoUrl(input.endpoint);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: input.timeoutMs });

    let barrier = await this.currentAuthBarrier();
    if (barrier === "mfa" || barrier === "captcha") barrier = await this.waitForManualAuthentication(barrier);
    if (barrier === "denied") {
      throw tangerinoErrors.authenticationRequired("A conta usada pelo agente não tem acesso à Admissão Digital.");
    }

    if (barrier === "login") {
      const user = await firstVisible([
        ...TangerinoSelectors.usernameLabels.map((label) => page.getByLabel(label)),
        ...TangerinoSelectors.usernameCss.map((css) => page.locator(css)),
      ]);
      const secret = await firstVisible([
        ...TangerinoSelectors.passwordLabels.map((label) => page.getByLabel(label)),
        ...TangerinoSelectors.passwordCss.map((css) => page.locator(css)),
      ]);
      if (!user || !secret) throw tangerinoErrors.uiChanged("autenticação", "campos de usuário e senha");
      await user.fill(input.username);
      await secret.fill(input.password);
      const submit = await firstVisible(TangerinoSelectors.submitButtons.map((name) => page.getByRole("button", { name })));
      if (!submit) throw tangerinoErrors.uiChanged("autenticação", "botão de entrar");
      await submit.click();
      await page.waitForLoadState("domcontentloaded", { timeout: input.timeoutMs }).catch(() => undefined);

      let afterBarrier = await this.currentAuthBarrier();
      if (afterBarrier === "mfa" || afterBarrier === "captcha") {
        afterBarrier = await this.waitForManualAuthentication(afterBarrier);
      }
      const after = await bodyText(page);
      if (afterBarrier === "denied") {
        throw tangerinoErrors.authenticationRequired("A conta usada pelo agente não tem acesso à Admissão Digital.");
      }
      // Continuar na tela de login depois de enviar as credenciais significa que
      // elas não servem. Repetir é o caminho mais curto para a conta do cliente
      // ser bloqueada por tentativas sucessivas, então não se repete.
      if (afterBarrier === "login" && !hasAny(after, TangerinoSelectors.authenticatedMarkers)) {
        throw tangerinoErrors.authenticationRequired("O Tangerino recusou as credenciais do agente.");
      }
    }
    this.authenticatedAt = Date.now();
  }

  async openAdmissions() {
    const page = this.requirePage();
    const existing = await this.resolveAdmissionsFrame(500);
    if (existing) {
      this.admissionsFrame = existing;
      this.selectedAdmissionCard = null;
      return;
    }
    const entry = await firstVisible([
      ...TangerinoSelectors.admissionsMenuText.map((text) =>
        page.locator(TangerinoSelectors.admissionsMenuCss).filter({ hasText: text })),
    ]);
    if (entry) {
      await entry.click();
      const overview = await firstVisible(TangerinoSelectors.admissionsOverviewLinks.map((name) =>
        page.getByRole("link", { name })));
      if (overview) await overview.click();
    }

    let frame = await this.resolveAdmissionsFrame(Math.min(5_000, tangerinoAgentConfig().timeoutMs));
    if (!frame) {
      /* A classe do item de menu varia entre versões do shell legado. A rota
         oficial da funcionalidade é mais estável e evita transformar mudança
         cosmética do menu em falha da integração. Continua sendo GET para um
         host fixo validado pela mesma barreira de navegação do login. */
      const directUrl = await assertAllowedTangerinoUrl(tangerinoAdmissionsOverviewUrl);
      await page.goto(directUrl.toString(), {
        waitUntil: "domcontentloaded", timeout: tangerinoAgentConfig().timeoutMs,
      });
      frame = await this.resolveAdmissionsFrame(Math.min(15_000, tangerinoAgentConfig().timeoutMs));
    }
    if (!frame) throw tangerinoErrors.uiChanged("abertura da Admissão", "iframe da lista de admissões");
    this.admissionsFrame = frame;
    this.selectedAdmissionCard = null;
    this.directAdmission = false;
  }

  /**
   * Pesquisa e devolve o que encontrou — sem escolher.
   *
   * A escolha é do `parser`, e é lá que mora a recusa de desempatar. Fazer o
   * cliente escolher a linha aqui esconderia a decisão dentro da automação, onde
   * ela não tem teste possível sem navegador.
   */
  async searchAdmission(term: string): Promise<AdmissionSearchHit[]> {
    const page = this.requirePage();
    const frame = this.requireAdmissionsFrame();
    const genericControls = 'input, textarea, [role="searchbox"], [contenteditable="true"]';
    await frame.locator(genericControls).first().waitFor({
      state: "visible", timeout: Math.min(15_000, tangerinoAgentConfig().timeoutMs),
    }).catch(() => undefined);
    let field = await firstVisible([
      ...TangerinoSelectors.searchPlaceholders.map((placeholder) => frame.getByPlaceholder(placeholder)),
      ...TangerinoSelectors.searchCss.map((css) => frame.locator(css)),
      frame.getByRole("searchbox"),
      frame.locator('input[type="search"]'),
      frame.locator('[contenteditable="true"][aria-label*="pesquis" i]'),
      frame.locator('[contenteditable="true"][aria-label*="busc" i]'),
    ]);
    if (!field) {
      /* Algumas versões retiram o placeholder do único filtro da lista. Só é
         seguro usar a estrutura como fallback quando existe exatamente um
         campo textual visível; com dois ou mais, escolher seria adivinhar. */
      const textInputs = frame.locator('input:not([type]), input[type="text"], textarea, [contenteditable="true"]');
      const visibleInputs: Locator[] = [];
      const total = Math.min(await textInputs.count().catch(() => 0), 20);
      for (let index = 0; index < total; index += 1) {
        const candidate = textInputs.nth(index);
        if (await isVisible(candidate)) visibleInputs.push(candidate);
      }
      if (visibleInputs.length === 1) field = visibleInputs[0];
    }
    if (!field) {
      const controls = frame.locator(genericControls);
      const signatures: string[] = [];
      const total = Math.min(await controls.count().catch(() => 0), 30);
      for (let index = 0; index < total; index += 1) {
        const candidate = controls.nth(index);
        if (!await isVisible(candidate)) continue;
        const tag = await candidate.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
        const type = await candidate.getAttribute("type").catch(() => null) ?? "";
        const name = await candidate.getAttribute("name").catch(() => null) ?? "";
        const placeholder = await candidate.getAttribute("placeholder").catch(() => null) ?? "";
        const role = await candidate.getAttribute("role").catch(() => null) ?? "";
        const label = await candidate.getAttribute("aria-label").catch(() => null) ?? "";
        signatures.push(`${tag}:${type}:${name}:${placeholder}:${role}:${label}`.slice(0, 180));
      }
      const body = frame.locator("body");
      const structure = await body.evaluate((element) => ({
        textLength: (element.textContent ?? "").length,
        childCount: element.children.length,
        scriptCount: element.querySelectorAll("script").length,
        classSignatures: Array.from(element.querySelectorAll("[class]")).slice(0, 60)
          .map((candidate) => `${candidate.tagName.toLowerCase()}.${String(candidate.getAttribute("class") ?? "").replace(/\s+/gu, ".")}`.slice(0, 140)),
        pagePath: (() => { try { return new URL(location.href).pathname; } catch { return ""; } })(),
      })).catch(() => ({ textLength: 0, childCount: 0, scriptCount: 0, classSignatures: [] as string[], pagePath: "" }));
      const localLogPath = String(process.env.FDP_TANGERINO_LOCAL_LOG_PATH ?? "").trim();
      if (localLogPath) {
        await page.screenshot({ path: join(dirname(localLogPath), "tangerino-search-not-found.png"), fullPage: true })
          .catch(() => undefined);
      }
      log("warn", "tangerino.admissions_search_not_found", {}, {
        inputCount: signatures.length, inputSignatures: signatures,
        bodyTextLength: structure.textLength, bodyChildCount: structure.childCount,
        scriptCount: structure.scriptCount, classSignatures: structure.classSignatures,
        framePath: structure.pagePath,
      });
      throw tangerinoErrors.uiChanged("pesquisa do colaborador", "campo de busca");
    }
    await field.fill(term);
    // O filtro Angular reage ao evento de entrada; Enter poderia acionar uma
    // ação de formulário que a tela real não exige. A resposta da API e a
    // reconstrução dos cartões não terminam junto com o evento `input`: na
    // aplicação real podem levar alguns segundos. Uma segunda leitura evita
    // transformar essa latência em "nenhuma admissão encontrada".
    await page.waitForTimeout(2_500);
    this.selectedAdmissionCard = null;
    let hits = await collectSearchHits(frame);
    if (hits.length === 0) {
      await page.waitForTimeout(2_500);
      hits = await collectSearchHits(frame);
    }
    return hits;
  }

  async openAdmission(hit: AdmissionSearchHit) {
    const cards = this.requireAdmissionsFrame().locator(TangerinoSelectors.resultCardCss);
    let card: Locator | null = null;
    const synthetic = /^card:(\d+)$/u.exec(hit.id);
    if (synthetic) {
      const index = Number(synthetic[1]);
      if (index < await cards.count().catch(() => 0)) card = cards.nth(index);
    } else {
      const total = Math.min(await cards.count().catch(() => 0), 25);
      for (let index = 0; index < total; index += 1) {
        const candidate = cards.nth(index);
        const id = await candidate.getAttribute("data-id").catch(() => null)
          ?? await candidate.getAttribute("id").catch(() => null);
        if (id === hit.id) { card = candidate; break; }
      }
    }
    if (!card || !await isVisible(card)) {
      if (/^[1-9][0-9]{0,19}$/u.test(hit.id)) {
        const page = this.requirePage();
        const directUrl = `https://admissao-demissao.tangerino.com.br/ficha-colaborador/${encodeURIComponent(hit.id)}`;
        await assertAllowedTangerinoUrl(directUrl);
        await page.goto(directUrl, { waitUntil: "domcontentloaded", timeout: tangerinoAgentConfig().timeoutMs });
        await page.locator("body").waitFor({
          state: "visible", timeout: Math.min(15_000, tangerinoAgentConfig().timeoutMs),
        });
        this.selectedAdmissionCard = null;
        this.directAdmission = true;
        return;
      }
      throw tangerinoErrors.uiChanged("seleção do processo", "cartão do resultado");
    }
    // Situação e etapa já estão no cartão. Selecioná-lo em memória evita abrir
    // ficha, documentos ou qualquer botão de significado operacional.
    this.selectedAdmissionCard = card;
    this.directAdmission = false;
  }

  async readAdmission(): Promise<AdmissionSnapshot> {
    if (!this.selectedAdmissionCard) {
      throw tangerinoErrors.uiChanged("leitura do processo", "cartão selecionado");
    }
    const snapshot = await readAdmissionCard(this.selectedAdmissionCard);
    // A conferência da §67 acontece aqui e não no `finally`: se a página tentou
    // alterar algo, a leitura já não é confiável e o resultado não deve ser
    // gravado como se fosse uma consulta limpa.
    const violation = this.blockedWrites[0];
    if (violation) throw tangerinoErrors.readOnlyViolation(violation.method, violation.path);
    return snapshot;
  }

  /**
   * Executa somente os dois downloads autorizados pelo cartão.
   *
   * Abrir o cartão é navegação. Os únicos botões aceitos têm nomes exatos de
   * download; nenhum seletor genérico de ação entra neste caminho.
   */
  async downloadAdmissionArtifacts(input: { externalAdmissionId: string; targetDirectory: string }) {
    const admissionId = input.externalAdmissionId.trim();
    if (!/^\d{1,20}$/u.test(admissionId)) {
      throw tangerinoErrors.uiChanged("download dos anexos", "identificador numérico da admissão");
    }
    if (!this.selectedAdmissionCard && !this.directAdmission) {
      throw tangerinoErrors.uiChanged("download dos anexos", "cartão selecionado");
    }
    await mkdir(input.targetDirectory, { recursive: true });
    const page = this.requirePage();
    let scope: TangerinoLocatorScope = this.directAdmission ? page : this.requireAdmissionsFrame();
    const saveArtifactDiagnostic = async (filename = "tangerino-artifact-not-found.png") => {
      const localLogPath = String(process.env.FDP_TANGERINO_LOCAL_LOG_PATH ?? "").trim();
      if (localLogPath) {
        await page.screenshot({ path: join(dirname(localLogPath), filename), fullPage: true })
          .catch(() => undefined);
      }
    };

    const exportRegistrationForm = async (formPage: Page) => {
      const exportLocators = () => TangerinoSelectors.exportRegistrationFormButtons.map((name) =>
        formPage.getByRole("button", { name }));
      await exportLocators()[0]?.first().waitFor({
        state: "visible", timeout: Math.min(20_000, tangerinoAgentConfig().timeoutMs),
      }).catch(() => undefined);
      let exportButton = await firstVisible(exportLocators());
      if (!exportButton) {
        // `domcontentloaded` antecede a inicialização do aplicativo Angular. Se
        // a primeira carga ficou incompleta (inclusive após um 502 transitório),
        // uma única recarga GET é segura e suficiente; nunca se repete o clique
        // que gera o arquivo.
        await formPage.reload({
          waitUntil: "domcontentloaded", timeout: Math.min(30_000, tangerinoAgentConfig().timeoutMs),
        }).catch(() => undefined);
        await exportLocators()[0]?.first().waitFor({
          state: "visible", timeout: Math.min(20_000, tangerinoAgentConfig().timeoutMs),
        }).catch(() => undefined);
        exportButton = await firstVisible(exportLocators());
      }
      if (!exportButton) {
        await saveArtifactDiagnostic("tangerino-registration-form-not-found.png");
        throw tangerinoErrors.uiChanged("download da ficha cadastral", "botão Exportar ficha do colaborador");
      }
      const formResponse = formPage.waitForResponse((response) => {
        try {
          const path = new URL(response.url()).pathname;
          return response.request().method() === "POST"
            && /\/api\/v1\/ficha-cadastral\/report\/\d+$/u.test(path);
        } catch { return false; }
      }, {
        timeout: Math.min(60_000, tangerinoAgentConfig().timeoutMs),
      });
      const formRequest = formPage.waitForRequest((request) => {
        try {
          const path = new URL(request.url()).pathname;
          return request.method() === "POST"
            && /\/api\/v1\/ficha-cadastral\/report\/\d+$/u.test(path);
        } catch { return false; }
      }, {
        timeout: Math.min(60_000, tangerinoAgentConfig().timeoutMs),
      });
      // A interface cria o PDF em JavaScript. Um clique de ponteiro forçado
      // pode acertar visualmente o botão sem executar o listener Angular quando
      // o overlay de carregamento está terminando. O `click()` nativo atua no
      // mesmo botão exato e dispara o listener registrado no próprio elemento.
      await exportButton.evaluate((element) => (element as HTMLButtonElement).click());
      await formRequest;
      log("info", "tangerino.attachments_registration_form_request_sent");
      const form = await formResponse;
      await assertAllowedTangerinoUrl(form.url());
      if (!form.ok()) throw tangerinoErrors.unavailable("A Sólides não concluiu o download da ficha cadastral.");
      const formBytes = await form.body();
      if (formBytes.byteLength < 5 || formBytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw tangerinoErrors.unavailable("A Sólides devolveu uma ficha cadastral inválida.");
      }
      const registrationFormPath = join(input.targetDirectory, "ficha-cadastral-solides.pdf");
      await writeFile(registrationFormPath, formBytes);
      return registrationFormPath;
    };

    let registrationFormPath: string | null = null;
    if (this.directAdmission) {
      /* A rota direta abre a ficha, não a visão geral do processo. Aproveitar
         essa tela primeiro garante a ficha; depois, o link oficial volta para
         a área em que o Tangerino/Sólides apresenta os documentos. */
      registrationFormPath = await exportRegistrationForm(page);
      const dashboardUrl = await assertAllowedTangerinoUrl(tangerinoAdmissionsOverviewUrl);
      await page.goto(dashboardUrl.toString(), {
        waitUntil: "domcontentloaded", timeout: Math.min(30_000, tangerinoAgentConfig().timeoutMs),
      });
      await page.waitForTimeout(1_000);
      const overviewFrame = await this.resolveAdmissionsFrame(Math.min(5_000, tangerinoAgentConfig().timeoutMs));
      if (overviewFrame) {
        this.admissionsFrame = overviewFrame;
        scope = overviewFrame;
      } else {
        // A visão geral também pode ser aberta como aplicativo de primeira
        // classe, sem o iframe do shell legado.
        scope = page;
      }
      await saveArtifactDiagnostic("tangerino-overview-after-form.png");
    } else if (this.selectedAdmissionCard) {
      const openDocuments = await firstVisible(TangerinoSelectors.openSubmittedDocumentsButtons.map((name) =>
        this.selectedAdmissionCard?.getByRole("button", { name }) ?? page.locator("__never__")));
      const openDetails = await firstVisible(TangerinoSelectors.openAdmissionDetailsButtons.map((name) =>
        this.selectedAdmissionCard?.getByRole("button", { name }) ?? page.locator("__never__")));
      if (openDocuments) await openDocuments.click();
      else if (openDetails) await openDetails.click();
      else await this.selectedAdmissionCard.click();

      // O primeiro botão só expande a linha do tempo. "Aprovar documentos" é o
      // cabeçalho de um `nz-collapse-panel`; o texto fica visível mesmo quando o
      // conteúdo e o botão de download continuam recolhidos. A presença do
      // título, portanto, não prova que a seção já abriu.
      await scope.locator(TangerinoSelectors.documentApprovalPanelHeaderCss).first().waitFor({
        state: "visible", timeout: Math.min(3_000, tangerinoAgentConfig().timeoutMs),
      }).catch(() => undefined);
      const downloadAlreadyVisible = await firstVisible(TangerinoSelectors.downloadAllDocumentsButtons.map((name) =>
        scope.getByRole("button", { name })));
      if (!downloadAlreadyVisible) {
        const approvalHeader = await firstVisible(TangerinoSelectors.documentApprovalSection.map((name) =>
          scope.locator(TangerinoSelectors.documentApprovalPanelHeaderCss).filter({ hasText: name })));
        if (approvalHeader) {
          log("info", "tangerino.attachments_approval_panel_opening");
          // O cabeçalho é o alvo exato e somente de leitura. A animação do
          // collapse mantém uma camada sobre ele e faz o clique convencional
          // esperar até o timeout, embora o próprio componente já esteja
          // visível. Forçar aqui só ignora essa checagem de ação, sem ampliar o
          // seletor nem permitir qualquer ação de alteração.
          await approvalHeader.click({ force: true });
          log("info", "tangerino.attachments_approval_panel_opened");
        }
      }
    }

    await scope.getByText(TangerinoSelectors.documentApprovalSection[0]).first().waitFor({
      state: "visible", timeout: Math.min(15_000, tangerinoAgentConfig().timeoutMs),
    }).catch(() => undefined);
    const section = await firstVisible(TangerinoSelectors.documentApprovalSection.map((name) => scope.getByText(name)));
    if (!section) await saveArtifactDiagnostic();
    if (!section) throw tangerinoErrors.uiChanged("download dos anexos", "seção Aprovar documentos");
    await scope.getByRole("button", { name: TangerinoSelectors.downloadAllDocumentsButtons[0] }).first().waitFor({
      state: "visible", timeout: Math.min(15_000, tangerinoAgentConfig().timeoutMs),
    }).catch(() => undefined);
    const downloadAll = await firstVisible(TangerinoSelectors.downloadAllDocumentsButtons.map((name) =>
      scope.getByRole("button", { name })));
    if (!downloadAll) await saveArtifactDiagnostic();
    if (!downloadAll) throw tangerinoErrors.uiChanged("download dos anexos", "botão Baixar todos os documentos");

    log("info", "tangerino.attachments_archive_download_starting");
    const archiveResponse = page.waitForResponse((response) => {
      try {
        return response.request().method() === "POST"
          && /\/api\/v1\/documentos\/admissao\/download-zip$/u.test(new URL(response.url()).pathname);
      } catch { return false; }
    }, { timeout: Math.min(60_000, tangerinoAgentConfig().timeoutMs) });
    const archiveRequest = page.waitForRequest((request) => {
      try {
        return request.method() === "POST"
          && /\/api\/v1\/documentos\/admissao\/download-zip$/u.test(new URL(request.url()).pathname);
      } catch { return false; }
    }, { timeout: Math.min(60_000, tangerinoAgentConfig().timeoutMs) });
    // O botão vive dentro do mesmo collapse animado do cabeçalho. A referência
    // continua restrita ao nome exato autorizado; o clique DOM evita que a
    // camada visual intercepte o evento antes de ele alcançar o listener
    // Angular `downloadTodosArquivos` confirmado no bundle oficial.
    await downloadAll.evaluate((element) => (element as HTMLButtonElement).click());
    await archiveRequest;
    log("info", "tangerino.attachments_archive_request_sent");
    const archive = await archiveResponse;
    await assertAllowedTangerinoUrl(archive.url());
    if (!archive.ok()) throw tangerinoErrors.unavailable("A Sólides não concluiu o download dos documentos.");
    const archiveBytes = await archive.body();
    const zipSignature = archiveBytes.subarray(0, 4).toString("hex");
    if (archiveBytes.byteLength < 22 || !["504b0304", "504b0506", "504b0708"].includes(zipSignature)) {
      throw tangerinoErrors.unavailable("A Sólides devolveu um arquivo de documentos inválido.");
    }
    log("info", "tangerino.attachments_archive_download_received");
    const documentArchivePath = join(input.targetDirectory, "documentos-solides.zip");
    await writeFile(documentArchivePath, archiveBytes);

    if (registrationFormPath) return { documentArchivePath, registrationFormPath };

    const formPage = await this.context?.newPage();
    if (!formPage) throw tangerinoErrors.unavailable("Não foi possível abrir a ficha cadastral.");
    try {
      formPage.setDefaultTimeout(Math.min(30_000, tangerinoAgentConfig().timeoutMs));
      const formUrl = `https://admissao-demissao.tangerino.com.br/ficha-colaborador/${encodeURIComponent(admissionId)}`;
      await assertAllowedTangerinoUrl(formUrl);
      await formPage.goto(formUrl, { waitUntil: "domcontentloaded", timeout: tangerinoAgentConfig().timeoutMs });
      registrationFormPath = await exportRegistrationForm(formPage);
      return { documentArchivePath, registrationFormPath };
    } finally {
      await formPage.close().catch(() => undefined);
    }
  }

  async back() {
    if (this.selectedAdmissionCard || this.directAdmission) {
      this.selectedAdmissionCard = null;
      this.directAdmission = false;
      return;
    }
    const page = this.requirePage();
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }

  async close() {
    /* Sem logout deliberado.
       "Sair" é um clique numa tela do cliente, e a §8 tira do agente todo clique
       que não seja navegação de leitura. Destruir o contexto já apaga cookie,
       localStorage e sessionStorage desta execução; a sessão do lado do
       Tangerino expira sozinha. */
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    if (!this.persistentProfile) await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
    this.admissionsFrame = null;
    this.selectedAdmissionCard = null;
    this.directAdmission = false;
    this.authenticatedAt = 0;
    this.persistentProfile = false;
  }
}

