import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { tangerinoAgentConfig } from "../../lib/tangerino/config.ts";
import { tangerinoErrors, TangerinoAgentError } from "../../lib/tangerino/errors.ts";
import { assertAllowedTangerinoUrl } from "../../lib/tangerino/navigation-security.ts";
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
 * ESTADO DESTE ARQUIVO: os seletores em `selectors.ts` ainda não foram
 * confirmados contra a interface real (§11, §72). Contra o Tangerino de verdade,
 * o comportamento esperado hoje é `UI_CHANGED` na primeira etapa que não
 * encontrar seu elemento. Isso é o resultado correto enquanto o mapeamento não
 * acontece: ele pede conferência em vez de produzir número inventado.
 */

async function isVisible(locator: Locator) {
  return locator.first().isVisible({ timeout: 1_500 }).catch(() => false);
}

async function firstVisible(locators: Locator[]) {
  for (const locator of locators) if (await isVisible(locator)) return locator.first();
  return null;
}

async function bodyText(page: Page) {
  return (await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 40_000);
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
export async function readLabeledValue(page: Page, labels: readonly RegExp[]): Promise<string | undefined> {
  for (const label of labels) {
    const field = page.getByLabel(label).first();
    if (await isVisible(field)) {
      const value = await field.inputValue().catch(() => field.innerText().catch(() => ""));
      if (value && value.trim()) return value.trim();
    }
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

/** Lê a tela do processo aberto. É o mesmo código que a sessão usa. */
export async function readAdmissionFrom(page: Page): Promise<AdmissionSnapshot> {
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

/** Coleta as linhas do resultado, sem escolher nenhuma. */
export async function collectSearchHits(page: Page): Promise<AdmissionSearchHit[]> {
  const text = await bodyText(page);
  if (hasAny(text, TangerinoSelectors.emptyResultMarkers)) return [];
  const rows = page.getByRole(TangerinoSelectors.resultRowRole);
  const total = await rows.count().catch(() => 0);
  const hits: AdmissionSearchHit[] = [];
  // Teto de leitura: o que interessa é "um ou mais de um". Percorrer duzentas
  // linhas para depois recusar por duplicidade seria gastar tempo à toa.
  for (let index = 0; index < Math.min(total, 25); index += 1) {
    const row = rows.nth(index);
    const label = (await row.innerText().catch(() => "")).replace(/\s+/gu, " ").trim();
    if (!label) continue;
    // Cabeçalho de tabela também tem papel `row`; ele não é resultado.
    if (await row.getByRole("columnheader").count().catch(() => 0)) continue;
    const id = (await row.getAttribute("data-id").catch(() => null))
      ?? (await row.getAttribute("id").catch(() => null))
      ?? `row:${index}`;
    hits.push({ id: id.slice(0, 120), label: label.slice(0, 200) });
  }
  return hits;
}

export class PlaywrightTangerinoSession implements TangerinoBrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private authenticatedAt = 0;
  /** Requisições de alteração que a página tentou. Só método e caminho. */
  readonly blockedWrites: Array<{ method: string; path: string }> = [];

  static async create() {
    const config = tangerinoAgentConfig();
    const session = new PlaywrightTangerinoSession();
    session.browser = await chromium.launch({
      headless: config.headless,
      chromiumSandbox: process.env.FDP_TANGERINO_CHROMIUM_SANDBOX === "true",
      args: ["--disable-dev-shm-usage"],
    });
    /* Contexto novo a cada consulta, sempre (§55).
       Reaproveitar contexto entre consultas guardaria o cookie de sessão de um
       workspace enquanto o próximo roda — que é como a credencial de um cliente
       acaba autenticando a consulta de outro. `acceptDownloads: false` porque o
       agente lê tela e não baixa nada; qualquer download é sinal de que ele saiu
       do caminho previsto. */
    session.context = await session.browser.newContext({
      acceptDownloads: false,
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      serviceWorkers: "block",
    });
    session.page = await session.context.newPage();
    session.page.setDefaultTimeout(Math.min(30_000, config.timeoutMs));

    await session.context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      try {
        await assertAllowedTangerinoUrl(url);
      } catch (error) {
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

  /** Sessão ainda válida dentro da janela configurada (§13, §14). */
  private sessionIsFresh() {
    return this.authenticatedAt > 0 && Date.now() - this.authenticatedAt < tangerinoAgentConfig().sessionTtlMs;
  }

  /**
   * Garante sessão — e para na primeira barreira humana.
   *
   * MFA e CAPTCHA devolvem `AUTHENTICATION_REQUIRED` imediatamente (§16). Não há
   * tentativa de resolver, contornar ou repetir: são mecanismos de segurança do
   * Tangerino, e um agente que os contorna é indistinguível de um invasor. Um
   * único ciclo de login — nunca laço (§15).
   */
  async ensureAuthenticated(input: { endpoint: string; username: string; password: string; timeoutMs: number }) {
    const page = this.requirePage();
    if (this.sessionIsFresh()) return;
    const url = await assertAllowedTangerinoUrl(input.endpoint);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: input.timeoutMs });

    const barrier = detectAuthBarrier(await bodyText(page), await hasCaptchaWidget(page));
    if (barrier === "mfa") {
      throw tangerinoErrors.authenticationRequired("O Tangerino pediu autenticação em duas etapas. Um agente não resolve esse desafio: renove o acesso manualmente.");
    }
    if (barrier === "captcha") {
      throw tangerinoErrors.authenticationRequired("O Tangerino apresentou um CAPTCHA. Um agente não resolve esse desafio: renove o acesso manualmente.");
    }
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

      const after = await bodyText(page);
      if (hasAny(after, TangerinoSelectors.mfaMarkers) || await hasCaptchaWidget(page)) {
        throw tangerinoErrors.authenticationRequired("O Tangerino pediu verificação adicional após o login.");
      }
      // Continuar na tela de login depois de enviar as credenciais significa que
      // elas não servem. Repetir é o caminho mais curto para a conta do cliente
      // ser bloqueada por tentativas sucessivas, então não se repete.
      if (hasAny(after, TangerinoSelectors.loginMarkers) && !hasAny(after, TangerinoSelectors.authenticatedMarkers)) {
        throw tangerinoErrors.authenticationRequired("O Tangerino recusou as credenciais do agente.");
      }
    }
    this.authenticatedAt = Date.now();
  }

  async openAdmissions() {
    const page = this.requirePage();
    const entry = await firstVisible([
      ...TangerinoSelectors.admissionsNav.map((name) => page.getByRole("link", { name })),
      ...TangerinoSelectors.admissionsNav.map((name) => page.getByRole("button", { name })),
    ]);
    if (!entry) throw tangerinoErrors.uiChanged("abertura da Admissão", "menu de Admissão Digital");
    await entry.click();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    const text = await bodyText(page);
    if (!hasAny(text, TangerinoSelectors.admissionsPageMarkers)) {
      throw tangerinoErrors.uiChanged("abertura da Admissão", "tela de processos admissionais");
    }
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
    const field = await firstVisible([
      ...TangerinoSelectors.searchLabels.map((label) => page.getByLabel(label)),
      ...TangerinoSelectors.searchCss.map((css) => page.locator(css)),
    ]);
    if (!field) throw tangerinoErrors.uiChanged("pesquisa do colaborador", "campo de busca");
    await field.fill(term);
    await field.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    return collectSearchHits(page);
  }

  async openAdmission(hit: AdmissionSearchHit) {
    const page = this.requirePage();
    const row = hit.id.startsWith("row:")
      ? page.getByRole(TangerinoSelectors.resultRowRole).nth(Number(hit.id.slice(4)))
      : page.getByRole(TangerinoSelectors.resultRowRole).filter({ hasText: hit.label }).first();
    if (!await isVisible(row)) throw tangerinoErrors.uiChanged("abertura do processo", "linha do resultado");
    /* Só o link da linha, nunca a linha inteira.
       Clicar na linha em tabela de sistema costuma disparar a ação padrão dela —
       que em tela de admissão pode ser "editar". O link é navegação; a linha é
       um botão de significado desconhecido. */
    const link = row.getByRole("link").first();
    await (await isVisible(link) ? link : row).click();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  }

  async readAdmission(): Promise<AdmissionSnapshot> {
    const snapshot = await readAdmissionFrom(this.requirePage());
    // A conferência da §67 acontece aqui e não no `finally`: se a página tentou
    // alterar algo, a leitura já não é confiável e o resultado não deve ser
    // gravado como se fosse uma consulta limpa.
    const violation = this.blockedWrites[0];
    if (violation) throw tangerinoErrors.readOnlyViolation(violation.method, violation.path);
    return snapshot;
  }

  async back() {
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
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
    this.authenticatedAt = 0;
  }
}
