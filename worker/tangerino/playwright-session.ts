import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { hasCardTextLabel, readCardTextValue } from "../../lib/tangerino/card-text.ts";
import { tangerinoAgentConfig } from "../../lib/tangerino/config.ts";
import { tangerinoErrors, TangerinoAgentError } from "../../lib/tangerino/errors.ts";
import { tangerinoAdmissionsEntryUrls, tangerinoAdmissionsOverviewUrl, tangerinoBrowserHosts } from "../../lib/tangerino/hosts.ts";
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

/** Lê o valor que está no mesmo bloco — ou na linha seguinte — do rótulo. */
async function readCardValue(card: Locator, labels: readonly RegExp[], cardText: string): Promise<string | undefined> {
  for (const label of labels) {
    const marker = card.getByText(label).first();
    if (!await isVisible(marker)) continue;
    const value = marker.locator("xpath=..").locator(TangerinoSelectors.cardValueCss).first();
    if (await isVisible(value)) {
      const text = (await value.innerText().catch(() => "")).trim();
      if (text) return text;
    }
    /* Reforço, não seletor novo: o rótulo já foi achado (`marker` está
       visível), só a classe específica do valor mudou ou não é essa. O mesmo
       recurso que `readLabeledValue` já usa e já se provou — ler o pai do
       rótulo e descontar o próprio texto do rótulo — funciona aqui pelo mesmo
       motivo: o valor costuma estar ao lado do rótulo, dentro do mesmo bloco,
       mesmo quando a classe do elemento que o carrega é outra. */
    const container = (await marker.locator("xpath=..").innerText().catch(() => "")).trim();
    const stripped = container.replace(label, "").replace(/^[\s:–—-]+/u, "").trim();
    if (stripped && stripped.length <= 200) return stripped;
  }
  /* Evidência real de 22/09/2026: o cartão completo estava certo e trazia os
     pares "Status da admissão"/"Concluído" e "Status da etapa"/"Admissão
     concluída" em linhas consecutivas, embora `getByText` não encontrasse um
     nó isolado para os rótulos. Lemos exatamente esse formato observado, sem
     acrescentar seletor CSS inventado. */
  return readCardTextValue(cardText, labels);
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

/**
 * Extrai o número da ficha de um link interno do cartão, se houver.
 *
 * `ficha-colaborador/{id}` é a mesma convenção de URL que `openAdmission` e
 * `downloadAdmissionArtifacts` já usam para navegar direto — não é seletor
 * novo, é a mesma rota do produto lida a partir de um `href` em vez de escrita
 * na barra de endereço. Puramente leitura: nunca clica no link.
 */
async function extractFichaColaboradorId(card: Locator): Promise<string | null> {
  const hrefs = await card.locator("a[href]").evaluateAll(
    (anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""),
  ).catch(() => [] as string[]);
  for (const href of hrefs) {
    const match = /ficha-colaborador\/([1-9][0-9]{0,19})(?:[/?#]|$)/u.exec(href);
    if (match) return match[1];
  }
  return null;
}

/** Lê um cartão real sem abrir ficha, documentos ou qualquer ação de edição. */
export async function readAdmissionCard(card: Locator): Promise<AdmissionSnapshot> {
  const title = card.locator(TangerinoSelectors.resultNameCss).first();
  const displayName = await title.getAttribute("title").catch(() => null)
    ?? await title.innerText().catch(() => "");
  const cardText = await card.innerText().catch(() => "");
  const rawStatus = await readCardValue(card, TangerinoSelectors.statusLabels, cardText);
  const stage = await readCardValue(card, TangerinoSelectors.stageLabels, cardText);

  /* `readCardValue` tenta primeiro o DOM conhecido e depois o par de linhas
   * confirmado no dump local. Se os dois falharem, este diagnóstico separa
   * ausência real de mudança na estrutura, sem revelar o conteúdo do cartão.
   *
   * Nada de PII vai para o log estruturado — ele é o que a pessoa que opera
   * cola direto nesta conversa. `looselyPresent` só diz se a PALAVRA aparece
   * em algum lugar do texto do cartão (o que distingue "nunca existiu aqui"
   * de "existe, mas não como nó isolado, colado a outra coisa"), e o
   * comprimento do texto, nunca o texto em si. O que TEM PII — texto e
   * imagem do cartão inteiro — só sai para o disco da própria máquina do DP,
   * e só quando `FDP_TANGERINO_LOCAL_LOG_PATH` está definido.
   */
  if (!rawStatus || !stage) {
    log("warn", "tangerino.card_field_not_found", {}, {
      rawStatusFound: Boolean(rawStatus), stageFound: Boolean(stage),
      cardTextLength: cardText.length,
      statusWordLooselyPresent: hasCardTextLabel(cardText, TangerinoSelectors.statusLabels),
      stageWordLooselyPresent: hasCardTextLabel(cardText, TangerinoSelectors.stageLabels),
    });
    const localLogPath = String(process.env.FDP_TANGERINO_LOCAL_LOG_PATH ?? "").trim();
    if (localLogPath) {
      const directory = dirname(localLogPath);
      await card.screenshot({ path: join(directory, "tangerino-card-field-not-found.png") }).catch(() => undefined);
      await writeFile(join(directory, "tangerino-card-field-not-found.txt"), cardText, "utf8").catch(() => undefined);
    }
  }

  const trimmedDisplayName = displayName.trim();
  const externalAdmissionId = await card.getAttribute("data-id").catch(() => null)
    ?? await card.getAttribute("id").catch(() => null)
    /* Terceira tentativa, e não invenção: o próprio agente já assume, em
     * `openAdmission` e em `downloadAdmissionArtifacts`, que uma ficha vive em
     * `ficha-colaborador/{id}` — essa é a convenção de URL do produto, não um
     * palpite novo. Se o cartão tiver um link interno para a própria ficha, o
     * número ali é tão estável quanto `data-id` seria. */
    ?? await extractFichaColaboradorId(card)
    /* Última tentativa, e decisão de produto — não seletor: uma execução real
     * provou, nos cinco cartões lidos, que esta conta não expõe protocolo nem
     * link algum (nem `hrefCount`, nem a palavra "protocolo" em lugar nenhum
     * do texto). Sem NENHUMA fonte técnica, o nome completo já lido no
     * cartão é o único dado estável disponível — confirmado com o DP como
     * aceitável para este grupo (risco de colisão só em homônimo exato
     * admitido ao mesmo tempo, na mesma empresa). O prefixo `nome:` deixa
     * claro, no banco e no log, que este identificador não veio de um
     * protocolo da origem. */
    ?? (trimmedDisplayName ? `nome:${trimmedDisplayName}` : undefined);

  /* Sem `data-id`/`id`, sem link para a ficha E sem nome legível: a leitura de
   * status e etapa deu certo, mas não há como gravar esta admissão sem
   * inventar identidade — `isStableExternalAdmissionId` recusa o índice
   * sintético por bom motivo (§47). Antes de tentar mais um seletor às cegas,
   * o mesmo par log-sem-PII + evidência local do bloco acima decide o
   * próximo passo. */
  if (!externalAdmissionId) {
    const hrefs = await card.locator("a[href]").evaluateAll(
      (anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? "").slice(0, 10),
    ).catch(() => [] as string[]);
    log("warn", "tangerino.card_identifier_not_found", {}, {
      externalIdWordLooselyPresent: hasCardTextLabel(cardText, TangerinoSelectors.externalIdLabels),
      hrefCount: hrefs.length,
      hrefWithDigitsCount: hrefs.filter((href) => /\d{2,}/u.test(href)).length,
    });
    const localLogPath = String(process.env.FDP_TANGERINO_LOCAL_LOG_PATH ?? "").trim();
    if (localLogPath) {
      const directory = dirname(localLogPath);
      await card.screenshot({ path: join(directory, "tangerino-card-identifier-not-found.png") }).catch(() => undefined);
      await writeFile(join(directory, "tangerino-card-identifier-not-found.txt"), cardText, "utf8").catch(() => undefined);
    }
  }

  return {
    externalAdmissionId,
    rawStatus,
    stage,
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
    /* O estado da ÚLTIMA volta do laço, não a primeira: se a página chegar a
       falar em admissão mas nunca juntar marcador de página com campo de
       busca, essa distinção é o que separa "quase lá" — vale esperar mais, ou
       o rótulo do marcador mudou — de "nunca foi a tela certa". Sem isso o
       diagnóstico final resume tudo em "não achei", que já se mostrou pouco
       acionável duas vezes seguidas nesta conta. */
    let lastPageDiag = { pageIsAdmissionsApp: false, pageMarkerFound: false, searchFieldFound: false };
    do {
      /* A lista nem sempre vem em iframe. Na conta real ela é a própria página
         do shell — e exigir o host do aplicativo autônomo fazia o worker olhar
         para a tela certa e concluir que não era ela. O que identifica a lista
         é o que ela mostra: o marcador da página E o campo de busca exato. Os
         dois juntos, num host da allowlist, não casam com outra tela. */
      const pageIsAdmissionsApp = (() => {
        try {
          const host = new URL(page.url()).hostname;
          return tangerinoBrowserHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
        } catch { return false; }
      })();
      if (pageIsAdmissionsApp && await isVisible(page.locator("body"))) {
        const pageMarker = await firstVisible(TangerinoSelectors.admissionsPageMarkers.map((text) => page.getByText(text)));
        const searchField = await firstVisible(TangerinoSelectors.searchPlaceholders.map((text) => page.getByPlaceholder(text)));
        lastPageDiag = { pageIsAdmissionsApp, pageMarkerFound: Boolean(pageMarker), searchFieldFound: Boolean(searchField) };
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

    /* "Não achei" não conserta nada: o que resolve é saber ONDE o navegador
       parou e o que a tela oferecia. Host e caminho, sem query — parâmetro de
       URL nesse produto carrega token de sessão. Os rótulos do menu são texto
       de interface, e são eles que dizem se a navegação mudou de lugar. */
    const local = (() => {
      try { const url = new URL(page.url()); return { host: url.hostname, path: url.pathname }; }
      catch { return { host: "", path: "" }; }
    })();
    const iframeHosts: string[] = [];
    const frames = page.locator("iframe");
    const totalFrames = Math.min(await frames.count().catch(() => 0), 10);
    for (let index = 0; index < totalFrames; index += 1) {
      const source = await frames.nth(index).getAttribute("src").catch(() => null);
      if (!source) continue;
      try { iframeHosts.push(new URL(source, page.url()).hostname); } catch { iframeHosts.push("(src inválido)"); }
    }
    /* Rótulo visível primeiro; título ou rótulo de acessibilidade quando não há
       texto — um item de menu recolhido a ícone costuma só ter um dos dois. */
    const menuLabels: string[] = [];
    const links = page.locator('a, [role="link"], button');
    const totalLinks = Math.min(await links.count().catch(() => 0), 120);
    for (let index = 0; index < totalLinks && menuLabels.length < 40; index += 1) {
      const candidate = links.nth(index);
      if (!await isVisible(candidate)) continue;
      const visible = (await candidate.innerText().catch(() => "")).replace(/\s+/gu, " ").trim();
      const fallback = visible || (await candidate.getAttribute("title").catch(() => null))
        || (await candidate.getAttribute("aria-label").catch(() => null)) || "";
      const label = fallback.replace(/\s+/gu, " ").trim();
      if (label && label.length <= 40) menuLabels.push(label);
    }
    /* Todo href que mencione admissão, visível ou não — isso separa "o link
       existe mas está escondido" (barra recolhida, submenu fechado) de "o link
       não existe nesta conta" (permissão negada, feature diferente), que têm
       conserto completamente diferente. */
    const admissionHrefs: string[] = [];
    const anchors = page.locator("a[href]");
    const totalAnchors = Math.min(await anchors.count().catch(() => 0), 300);
    for (let index = 0; index < totalAnchors && admissionHrefs.length < 10; index += 1) {
      const source = await anchors.nth(index).getAttribute("href").catch(() => null);
      if (source && /admiss/iu.test(source)) admissionHrefs.push(source.slice(0, 160));
    }
    const collapsibleCount = await page.locator("[aria-expanded]").count().catch(() => 0);
    const localLogPath = String(process.env.FDP_TANGERINO_LOCAL_LOG_PATH ?? "").trim();
    if (localLogPath) {
      await page.screenshot({ path: join(dirname(localLogPath), "tangerino-admissions-not-found.png"), fullPage: true })
        .catch(() => undefined);
    }
    log("warn", "tangerino.admissions_frame_not_found", {}, {
      iframeCount: totalFrames, pageHost: local.host, pagePath: local.path,
      iframeHosts: [...new Set(iframeHosts)], menuLabels,
      admissionHrefs: [...new Set(admissionHrefs)], collapsibleCount,
      /* A ÚLTIMA leitura antes de desistir: se pageMarkerFound e
         searchFieldFound vierem os dois false com pageIsAdmissionsApp true, a
         página nunca teve o marcador nem a busca — a tela real é outra coisa.
         Se um dos dois vier true, faltou só o outro — provável questão de
         tempo, ou aquele seletor específico mudou. */
      ...lastPageDiag,
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
    /* Rota A: clicar em "Admissão" e depois em "Visão geral" — o caminho que
     * uma pessoa realmente usa (Tela inicial → Admissão → Visão geral → aba
     * "Dados contratuais"), confirmado numa conta real.
     *
     * A busca não se limita à classe CSS conhecida nem ao tipo de elemento: um
     * item de menu de SPA é tão frequentemente uma `<div>`/`<li>` com um
     * ouvinte de clique quanto um `<a>`, e a classe muda entre contas e versões
     * do shell (era esse o caso aqui — o rótulo "Admissão" não apareceu na
     * varredura de `a, [role=link], button` que gerou o diagnóstico §92,
     * mesmo existindo na tela). Uma segunda tentativa depois de uma pausa
     * cobre o menu que ainda está montando quando a primeira olha.
     */
    const findAdmissionEntry = () => firstVisible([
      ...TangerinoSelectors.admissionsMenuText.map((text) =>
        page.locator(TangerinoSelectors.admissionsMenuCss).filter({ hasText: text })),
      ...TangerinoSelectors.admissionsMenuText.map((text) => page.getByRole("link", { name: text })),
      ...TangerinoSelectors.admissionsMenuText.map((text) => page.getByRole("button", { name: text })),
      ...TangerinoSelectors.admissionsMenuText.map((text) => page.getByRole("menuitem", { name: text })),
      ...TangerinoSelectors.admissionsMenuText.map((text) => page.getByText(text, { exact: true })),
    ]);
    let entry = await findAdmissionEntry();
    if (!entry) {
      await page.waitForTimeout(2_500);
      entry = await findAdmissionEntry();
    }
    if (entry) {
      await entry.click();
      const overview = await firstVisible([
        ...TangerinoSelectors.admissionsOverviewLinks.map((name) => page.getByRole("link", { name })),
        ...TangerinoSelectors.admissionsOverviewLinks.map((name) => page.getByText(name, { exact: true })),
      ]);
      if (overview) await overview.click();
    }

    let frame = await this.resolveAdmissionsFrame(Math.min(5_000, tangerinoAgentConfig().timeoutMs));

    /* Rota B: procurar pelo destino, não pelo rótulo.
     *
     * O texto do menu muda entre contas — uma delas nem mostrou "Admissão"
     * entre os rótulos visíveis (`tangerino.admissions_entry_attempt` §90). O
     * endereço do módulo não muda do mesmo jeito: ele é a própria allowlist.
     * Clicar em vez de navegar direto importa aqui — este produto tem cara de
     * aplicação com estado de sessão por página (Wicket): uma navegação "fria"
     * para o endereço profundo pode não achar esse estado e voltar para a
     * página inicial, enquanto um clique carrega a partir de uma página que já
     * o tem.
     */
    if (!frame) {
      const byHref = page.locator('a[href*="admissao-demissao" i], a[href*="admissao_demissao" i]').first();
      if (await isVisible(byHref)) {
        await byHref.click();
        frame = await this.resolveAdmissionsFrame(Math.min(8_000, tangerinoAgentConfig().timeoutMs));
      }
    }

    /* Rota C: a barra pode estar recolhida.
     *
     * Um menu lateral fechado em ícones esconde o rótulo de texto que as duas
     * rotas acima procuram — e foi exatamente essa a aparência do print que
     * motivou este mapeamento. Um alvo de expansão é reconhecido pela função,
     * não pelo nome da classe: `aria-expanded="false"` ou um rótulo de
     * acessibilidade que diga "menu"/"expandir", perto do topo da barra.
     */
    if (!frame) {
      const toggle = await firstVisible([
        page.locator('[aria-expanded="false"]').first(),
        page.getByRole("button", { name: /^(expandir|abrir) menu$/iu }),
        page.getByLabel(/^(expandir|abrir) menu$/iu),
      ]);
      if (toggle) {
        await toggle.click().catch(() => undefined);
        const afterExpand = await firstVisible([
          ...TangerinoSelectors.admissionsMenuText.map((text) => page.getByRole("link", { name: text })),
          ...TangerinoSelectors.admissionsMenuText.map((text) => page.getByText(text, { exact: true })),
        ]);
        if (afterExpand) {
          await afterExpand.click();
          frame = await this.resolveAdmissionsFrame(Math.min(8_000, tangerinoAgentConfig().timeoutMs));
        }
      }
    }

    /* Rota D: Admissão pode viver DENTRO de uma categoria, não ao lado dela.
     *
     * Uma conta real mostrou um menu de categorias (Empregador, Cadastros
     * gerais, Financeiro, Ponto) sem "Admissão" nenhuma visível ao lado — o
     * padrão comum nesse tipo de produto é a função morar dentro da categoria
     * de RH. Cada candidata é clicada e revertida (`back`, sem submeter nada)
     * se não revelar o que procuramos, para não deixar o menu aberto atrapalhar
     * a rota seguinte.
     */
    if (!frame) {
      for (const category of TangerinoSelectors.admissionsParentCategories) {
        const parent = page.getByText(category, { exact: true }).first();
        if (!await isVisible(parent)) continue;
        await parent.click().catch(() => undefined);
        const revealed = await firstVisible([
          ...TangerinoSelectors.admissionsMenuText.map((text) => page.getByRole("link", { name: text })),
          ...TangerinoSelectors.admissionsMenuText.map((text) => page.getByText(text, { exact: true })),
        ]);
        if (revealed) {
          await revealed.click();
          frame = await this.resolveAdmissionsFrame(Math.min(8_000, tangerinoAgentConfig().timeoutMs));
        }
        if (frame) break;
      }
    }

    /* A classe do item de menu varia entre versões do shell legado, então a
       navegação direta é o caminho confiável. As entradas são tentadas em
       ordem porque uma conta real mostrou que a primeira nem sempre serve: o
       aplicativo autônomo redirecionava de volta ao painel do shell, e o worker
       ficava parado numa tela sem admissão nenhuma. Continuam sendo GET, para
       hosts da allowlist, validadas pela mesma barreira do login. */
    for (const candidate of tangerinoAdmissionsEntryUrls) {
      if (frame) break;
      const directUrl = await assertAllowedTangerinoUrl(candidate);
      const navigated = await page.goto(directUrl.toString(), {
        waitUntil: "domcontentloaded", timeout: tangerinoAgentConfig().timeoutMs,
      }).then(() => true).catch(() => false);

      /* Onde a navegação PAROU, e não para onde ela foi pedida. Um endereço de
         módulo que volta para a home é a assinatura de conta sem acesso àquele
         módulo — e sem registrar o destino real isso fica indistinguível de
         rota errada, que tem conserto completamente diferente. */
      const landed = (() => {
        try { const url = new URL(page.url()); return `${url.hostname}${url.pathname}`; }
        catch { return ""; }
      })();
      const mentionsAdmission = await page.locator("body").innerText()
        .then((body) => /admiss[ãa]o/iu.test(body)).catch(() => false);
      log("info", "tangerino.admissions_entry_attempt", {}, {
        pedido: new URL(directUrl.toString()).pathname, chegou: landed,
        navegou: navigated, telaFalaEmAdmissao: mentionsAdmission,
      });

      /* O orçamento inteiro, e não um teto de 15s: uma navegação FRIA para uma
       * SPA bootstrapa do zero — sem o estado que um clique dentro do
       * aplicativo já carrega. Uma conta real chegou exatamente no endereço
       * pedido e com "admissão" no corpo da página (`telaFalaEmAdmissao:
       * true`) e ainda assim não formou o par marcador+busca a tempo dentro de
       * 15s. As outras rotas (clique dentro do app) continuam com o teto
       * curto, porque ali não há bootstrap frio para esperar.
       */
      frame = await this.resolveAdmissionsFrame(tangerinoAgentConfig().timeoutMs);
    }

    /* Rota E: "Admissão" tem uma tela intermediária própria, com o seu botão
     * "Visão Geral" — não a lista.
     *
     * Confirmado por captura de tela numa conta real: clicar "Admissão" (ou
     * navegar direto para o módulo) leva a um painel do tipo "Boa noite,
     * OPYT!" com atalhos e sugestões, e é dali que se clica em "Visão Geral"
     * para chegar na lista com as abas (Todas admissões, Dados contratuais,
     * ...). As rotas acima clicam nesse botão só uma vez, logo depois de abrir
     * o menu — antes de essa tela intermediária existir. Aqui é a última
     * chance, depois de qualquer navegação ter parado numa página que fala em
     * admissão sem ainda ser a lista.
     */
    if (!frame) {
      const overview = await firstVisible([
        ...TangerinoSelectors.admissionsOverviewLinks.map((name) => page.getByRole("link", { name })),
        ...TangerinoSelectors.admissionsOverviewLinks.map((name) => page.getByRole("button", { name })),
        ...TangerinoSelectors.admissionsOverviewLinks.map((name) => page.getByText(name, { exact: true })),
      ]);
      if (overview) {
        await overview.click();
        frame = await this.resolveAdmissionsFrame(Math.min(10_000, tangerinoAgentConfig().timeoutMs));
      }
    }
    if (!frame) throw tangerinoErrors.uiChanged("abertura da Admissão", "lista de admissões");
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
  async listAdmissions(): Promise<AdmissionSearchHit[]> {
    /* Sem preencher a busca: a lista já chega povoada com as admissões em
       aberto, e é essa a leitura que descobre quem o Vinculato não conhece.
       A segunda tentativa existe pelo mesmo motivo da busca — os cartões são
       montados por uma chamada assíncrona, e ler cedo demais devolveria zero
       onde há gente. */
    const page = this.requirePage();
    const frame = this.requireAdmissionsFrame();

    /* Duas execuções reais confirmaram, com as oito abas visíveis
     * (`admissions_list_diagnostic`), que a lista real é a tela certa — e
     * mesmo assim só cinco cartões apareciam, sempre "Admissão concluída".
     * A aba ativa por padrão não é "Todas admissões": é a que ficou
     * selecionada da última vez, e sem clicar a descoberta nunca chega nos
     * cinco processos em "Dados contratuais" que o DP confirmou existirem.
     * Clicar é seguro — é a mesma aba que o print do operador já mostrou,
     * não um botão de ação — e só afeta esta sessão (`listAdmissions` só é
     * chamado pela descoberta; a consulta nomeada usa `searchAdmission`,
     * numa sessão própria). */
    /* `isVisible` sozinho (1.5s) devolveu falso numa execução real, no mesmo
     * instante em que a barra de abas ainda não tinha renderizado — a prova
     * veio do diagnóstico logo abaixo, que a encontrou poucos segundos depois,
     * já com os cartões carregados. `waitFor` dá à aba o mesmo tipo de tempo
     * que já é dado ao primeiro cartão, em vez de decidir cedo demais que ela
     * não existe. */
    const contractDataTab = frame.getByText(TangerinoSelectors.admissionsContractDataTab).first();
    const contractDataTabClicked = await contractDataTab.waitFor({
      state: "visible", timeout: Math.min(10_000, tangerinoAgentConfig().timeoutMs),
    }).then(() => true).catch(() => false);
    if (contractDataTabClicked) {
      await contractDataTab.click().catch(() => undefined);
      await page.waitForTimeout(2_500);
    }

    await frame.locator(TangerinoSelectors.resultCardCss).first()
      .waitFor({ state: "visible", timeout: Math.min(15_000, tangerinoAgentConfig().timeoutMs) })
      .catch(() => undefined);
    this.selectedAdmissionCard = null;
    let hits = await collectSearchHits(frame);
    if (hits.length === 0) {
      await page.waitForTimeout(2_500);
      hits = await collectSearchHits(frame);
    }

    /* Nome de aba e contagem não são PII (é rótulo de interface, igual ao que
     * já está nos comentários deste arquivo): seguro no log estruturado. */
    const tabLabels: string[] = [];
    for (const pattern of TangerinoSelectors.admissionsTabLabels) {
      const label = frame.getByText(pattern).first();
      if (await isVisible(label)) tabLabels.push((await label.innerText().catch(() => "")).trim().slice(0, 60));
    }
    log("info", "tangerino.admissions_list_diagnostic", {}, {
      cardCount: hits.length, tabLabelsFound: tabLabels, contractDataTabClicked,
    });

    return hits;
  }

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
    let admissionId = input.externalAdmissionId.trim();
    if (!/^\d{1,20}$/u.test(admissionId)) {
      /* Motivo, não invenção: nesta conta o cartão da lista não expõe
       * protocolo (PRs #163/#164), então `externalAdmissionId` pode ser o
       * nome prefixado (`nome:...`), não um identificador real do Tangerino.
       * Antes de desistir, tenta o mesmo link para a ficha que
       * `readAdmissionCard` já procura, agora no cartão que a busca por
       * nome selecionou — um resultado de busca pode expor mais do que a
       * lista sem filtro expunha. Se também faltar, o erro abaixo continua
       * claro sobre o que falta. */
      const extracted = this.selectedAdmissionCard ? await extractFichaColaboradorId(this.selectedAdmissionCard) : null;
      if (!extracted) throw tangerinoErrors.uiChanged("download dos anexos", "identificador numérico da admissão");
      admissionId = extracted;
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

