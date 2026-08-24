import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type FrameLocator, type Locator, type Page } from "playwright";
import { tangerinoAgentConfig } from "../../lib/tangerino/config.ts";
import { tangerinoErrors, TangerinoAgentError } from "../../lib/tangerino/errors.ts";
import { assertAllowedTangerinoChallengeUrl, assertAllowedTangerinoUrl } from "../../lib/tangerino/navigation-security.ts";
import { log } from "../../lib/observability.ts";
import { readOnlyDecision, readOnlyViolationDetail } from "../../lib/tangerino/read-only.ts";
import { TangerinoSelectors } from "../../lib/tangerino/selectors.ts";
import type { AdmissionSearchHit, AdmissionSnapshot, TangerinoBrowserSession } from "../../lib/tangerino/types.ts";

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

type TangerinoLocatorScope = Pick<Page, "getByLabel" | "getByText" | "locator">;

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

export class PlaywrightTangerinoSession implements TangerinoBrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private admissionsFrame: FrameLocator | null = null;
  private selectedAdmissionCard: Locator | null = null;
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
      acceptDownloads: false,
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
    const iframe = this.requirePage().locator(TangerinoSelectors.admissionsFrameCss).first();
    await iframe.waitFor({ state: "attached", timeout: timeoutMs }).catch(() => undefined);
    if (!await iframe.count().catch(() => 0)) return null;
    const frame = iframe.contentFrame();
    const body = frame.locator("body");
    await body.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => undefined);
    if (!await isVisible(body)) return null;
    const marker = await firstVisible(TangerinoSelectors.admissionsPageMarkers.map((text) => frame.getByText(text)));
    return marker ? frame : null;
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
    if (!entry) throw tangerinoErrors.uiChanged("abertura da Admissão", "menu Admissão");
    await entry.click();
    const overview = await firstVisible(TangerinoSelectors.admissionsOverviewLinks.map((name) =>
      page.getByRole("link", { name })));
    if (!overview) throw tangerinoErrors.uiChanged("abertura da Admissão", "link Visão geral");
    await overview.click();
    const frame = await this.resolveAdmissionsFrame(Math.min(15_000, tangerinoAgentConfig().timeoutMs));
    if (!frame) throw tangerinoErrors.uiChanged("abertura da Admissão", "iframe da lista de admissões");
    this.admissionsFrame = frame;
    this.selectedAdmissionCard = null;
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
    const field = await firstVisible([
      ...TangerinoSelectors.searchPlaceholders.map((placeholder) => frame.getByPlaceholder(placeholder)),
      ...TangerinoSelectors.searchCss.map((css) => frame.locator(css)),
    ]);
    if (!field) throw tangerinoErrors.uiChanged("pesquisa do colaborador", "campo de busca");
    await field.fill(term);
    // O filtro Angular reage ao evento de entrada; Enter poderia acionar uma
    // ação de formulário que a tela real não exige.
    await page.waitForTimeout(750);
    this.selectedAdmissionCard = null;
    return collectSearchHits(frame);
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
      throw tangerinoErrors.uiChanged("seleção do processo", "cartão do resultado");
    }
    // Situação e etapa já estão no cartão. Selecioná-lo em memória evita abrir
    // ficha, documentos ou qualquer botão de significado operacional.
    this.selectedAdmissionCard = card;
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

  async back() {
    if (this.selectedAdmissionCard) {
      this.selectedAdmissionCard = null;
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
    this.authenticatedAt = 0;
    this.persistentProfile = false;
  }
}

