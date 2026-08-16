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
// `acceptDownloads` para conferir o CSV exportado: o arquivo é o único
// artefato do produto que sai do navegador e vai para a mão de alguém.
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR", acceptDownloads: true });
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
  // O console navega por URL (`?area=...`), então a marcação correta é <nav>
  // com `aria-current="page"` — não `role="tablist"`, que descreveria painéis
  // trocados dentro da mesma página. Esta verificação esperava tablist e falhava
  // contra um console que está certo: ela ficou para trás porque nunca rodava.
  await page.waitForSelector("nav button[aria-current]", { timeout: 20000 }).catch(() => undefined);
  const areaButtons = await page.locator("nav button").count();
  record("o console global abre para o administrador da plataforma",
    areaButtons > 0 && await page.locator('nav button[aria-current="page"]').count() > 0,
    `${areaButtons} área(s) · ${(await page.locator("h1").first().innerText().catch(() => "")).slice(0, 40)}`);

  // As áreas ficam atrás da navegação: chegar em Clientes é o que traz a tabela.
  await page.locator("nav button").filter({ hasText: /Clientes/u }).first().click().catch(() => undefined);

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
  // O provisionamento passa a exigir motivo escrito e confirmação explícita —
  // toda alteração administrativa registra o porquê. Sem preencher os dois, o
  // formulário nem envia, e a verificação acusava falha de criação onde havia
  // apenas campo obrigatório novo.
  await page.locator('textarea[name="reason"]').fill("Ensaio automatizado de provisionamento pela interface.");
  await page.locator('input[name="confirmed"]').check();
  await page.getByRole("button", { name: /Criar workspace/u }).click();
  await page.waitForSelector('[role="status"]', { timeout: 20000 }).catch(() => undefined);
  const toast = await page.locator('[role="status"]').first().innerText().catch(() => "");
  record("criar workspace pela interface funciona", /criado/iu.test(toast), toast.slice(0, 80));

  // A tabela recarrega por fetch depois da criação. Contar assim que o aviso
  // aparece mede o estado anterior — é a mesma armadilha que esta verificação
  // já evitava na primeira contagem e esquecia aqui.
  await page.waitForFunction(
    (anterior) => document.querySelectorAll("table tbody tr").length > anterior,
    workspaceRows,
    { timeout: 20000 },
  ).catch(() => undefined);
  const afterRows = await page.locator("table tbody tr").count();
  record("o workspace criado aparece na tabela", afterRows > workspaceRows, `${workspaceRows} → ${afterRows}`);

  // Criar um cliente abre a gaveta de detalhe dele, que é modal e cobre a
  // navegação — comportamento correto. Sem fechá-la, o clique seguinte bate no
  // overlay e a verificação acusa falha de navegação onde há apenas um diálogo
  // aberto esperando ser fechado.
  await page.getByRole("button", { name: /^Fechar$/u }).first().click().catch(() => undefined);
  await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10000 }).catch(() => undefined);

  // Aba de usuários
  await page.locator("nav button").filter({ hasText: /Usuários/u }).first().click();
  // Esperar por `table tbody tr` logo após o clique casa com as linhas da área
  // anterior, que ainda estão no DOM: a contagem seguinte cai no vazio entre a
  // tabela velha sair e a nova chegar. A espera é pela área virar corrente e,
  // só então, por linhas de verdade.
  await page.waitForFunction(
    () => document.querySelector('nav button[aria-current="page"]')?.textContent?.includes("Usuários") ?? false,
    undefined,
    { timeout: 20000 },
  ).catch(() => undefined);
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr").length > 0,
    undefined,
    { timeout: 20000 },
  ).catch(() => undefined);
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

// 4a. Revisão de acesso: ela vive no console da plataforma, não no painel.
//
//     Esta verificação esperava a tela em `/painel` e falhava contra um produto
//     que está certo. A administração de identidades foi movida para o console
//     global de propósito — `tests/access-screen.test.mts` guarda essa decisão e
//     reprova se `AccessView` voltar ao painel. A verificação ficou para trás
//     porque nunca rodava.
if (password) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
  record("o painel operacional não administra identidades globais",
    await page.getByRole("button", { name: /Usuários e permissões/u }).count() === 0);

  await page.goto(`${base}/plataforma?area=users`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length > 0, undefined, { timeout: 20000 })
    .catch(() => undefined);
  const globalUsers = await page.locator("table tbody tr").count();
  record("o console global lista as identidades", globalUsers > 0, `${globalUsers} conta(s)`);
  const globalText = await page.locator("main").innerText().catch(() => "");
  record("a tela global nunca mostra hash de senha", !/\$argon|\$2[aby]\$|password_hash/u.test(globalText));
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

// 4c. O seletor de empresa recorta a visão geral, não só o quadro.
//
//     Ele ficava aparente em toda tela e só o quadro o respeitava: escolher uma
//     empresa não mexia em número nenhum da visão geral. Nenhum ensaio acusava
//     porque a semente tinha uma empresa só — com uma, um seletor que recorta e
//     um seletor que não faz nada produzem exatamente a mesma tela.
if (password) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overview-metrics article strong", { timeout: 25000 }).catch(() => undefined);
  await page.waitForTimeout(1200);

  const chamadas = [];
  const escuta = (request) => { if (request.url().includes("action-center")) chamadas.push(request.url()); };
  page.on("request", escuta);

  const abertasNoGrupo = Number((await page.locator(".overview-metrics article strong").first().innerText().catch(() => "0")).trim());
  const seletor = page.getByLabel("Selecionar empresa");
  const valores = await seletor.locator("option").evaluateAll((options) => options.map((option) => option.value));
  const vazia = valores.find((value) => value.startsWith("co-ui-2"));

  if (!vazia) {
    record("a semente tem uma empresa sem demanda para provar o recorte", false, valores.join(", "));
  } else {
    await seletor.selectOption(vazia);
    await page.waitForTimeout(1800);
    const abertasNaFilial = Number((await page.locator(".overview-metrics article strong").first().innerText().catch(() => "-1")).trim());
    record("escolher empresa recorta os indicadores da visão geral",
      abertasNoGrupo > 0 && abertasNaFilial === 0, `grupo ${abertasNoGrupo} → filial sem demanda ${abertasNaFilial}`);

    const resumo = await page.locator(".overview-hero span").first().innerText().catch(() => "");
    record("a visão geral diz de quem são os números", /FILIAL VAZIA/u.test(resumo), resumo);

    const ultima = chamadas[chamadas.length - 1] ?? "";
    record("a central de ação consulta o servidor com a empresa escolhida",
      ultima.includes(`companyId=${vazia}`), ultima.slice(-70) || "nenhuma chamada");
  }
  page.off("request", escuta);
  await seletor.selectOption("all").catch(() => undefined);
}

// 4d. Relatórios e a exportação seguem o recorte de empresa.
//
//     O CSV é o pior caso do filtro ignorado: a tela mostrando o grupo inteiro
//     é confuso; um arquivo com o grupo inteiro, baixado logo depois de
//     escolher uma empresa, sai daqui parecendo ser daquela empresa.
if (password) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
  await page.getByRole("button", { name: /^Relatórios$/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(1800);

  const linhasDoCsv = async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      page.getByRole("button", { name: /Exportar CSV/u }).first().click(),
    ]);
    const caminho = await download.path();
    const { readFileSync } = await import("node:fs");
    return readFileSync(caminho, "utf8").replace(/^\uFEFF/u, "").trim().split("\n");
  };

  const doGrupo = await linhasDoCsv().catch(() => null);
  record("a exportação do grupo traz as demandas", Boolean(doGrupo && doGrupo.length > 1),
    doGrupo ? `${doGrupo.length - 1} linha(s) além do cabeçalho` : "download não aconteceu");

  const seletor = page.getByLabel("Selecionar empresa");
  await seletor.selectOption("co-ui-2").catch(() => undefined);
  await page.waitForTimeout(1800);

  const volume = await page.locator(".metrics-panel header span").first().innerText().catch(() => "");
  record("Relatórios recorta pela empresa escolhida", /^0 demanda\(s\)/u.test(volume), volume);
  record("Relatórios diz de quem são os números", /Filial Vazia/u.test(volume), volume);

  const daFilial = await linhasDoCsv().catch(() => null);
  record("a exportação segue o recorte, e não o grupo",
    Boolean(daFilial && daFilial.length === 1),
    daFilial ? `${daFilial.length - 1} linha(s) além do cabeçalho` : "download não aconteceu");

  await seletor.selectOption("all").catch(() => undefined);
  await page.waitForTimeout(1200);

  // A exportação completa do grupo (§50) precisa de porta alcançável. A
  // primeira tentativa colocou o botão na tela de assinatura — que não é
  // renderizada por lugar nenhum do painel. Um botão numa tela inalcançável é
  // exatamente a promessa sem porta que a exportação veio resolver.
  const exportarTudo = page.getByRole("link", { name: /Exportar tudo \(JSON\)/u });
  record("a exportação completa do grupo tem porta na interface", await exportarTudo.count() > 0);
  if (await exportarTudo.count()) {
    const [arquivo] = await Promise.all([
      page.waitForEvent("download", { timeout: 25000 }),
      exportarTudo.first().click(),
    ]);
    const { readFileSync } = await import("node:fs");
    const conteudo = JSON.parse(readFileSync(await arquivo.path(), "utf8"));
    const tabelas = Object.keys(conteudo.tabelas ?? {}).length;
    record("o arquivo traz o grupo inteiro", tabelas > 50, `${tabelas} tabela(s)`);
    record("o arquivo declara o que omitiu", (conteudo.omissoes ?? []).length > 0,
      `${(conteudo.omissoes ?? []).length} coluna(s) com motivo`);
    const cru = JSON.stringify(conteudo);
    record("nenhum segredo cifrado no arquivo",
      !/"[a-z_]*(secret|encrypted|token_hash|lease_token)[a-z_]*":/u.test(cru));
  }
}

// 4f. A escrita operacional pela interface (§39).
//
//     As conferências anteriores cobriam navegação, permissão, recorte,
//     relatório e SEO — nenhuma escrevia. Criar demanda é a ação central do
//     produto: se o formulário quebrar, a coluna sumir ou a persistência
//     falhar, tudo aqui continuaria verde. Este bloco faz o caminho inteiro
//     pela tela, como uma pessoa faz, e confere no fim que a demanda ficou.
if (password) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
  await page.getByRole("button", { name: /^Demandas$/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(1500);

  const titulo = `Ensaio de ponta a ponta ${Date.now()}`;
  await page.getByRole("button", { name: /Nova demanda/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(900);

  const dialogo = page.getByRole("dialog");
  record("o formulário de nova demanda abre", await dialogo.count() > 0);

  await page.getByLabel(/Título da demanda/u).first().fill(titulo).catch(() => undefined);
  await page.getByLabel(/^Descrição$/u).first().fill("Criada pela verificação de navegador.").catch(() => undefined);
  await page.getByRole("button", { name: /Criar demanda|^Salvar$/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(2500);

  const noQuadro = await page.getByText(titulo, { exact: false }).count();
  record("a demanda criada aparece no quadro", noQuadro > 0, `${noQuadro} ocorrência(s)`);

  // Persistiu de verdade, ou só ficou no estado do React? A recarga responde —
  // mas o painel reabre na Visão geral, então é preciso voltar a Demandas antes
  // de procurar. Sem isso a conferência mediria "o título aparece na primeira
  // tela que carregar", que não é a pergunta.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
  await page.getByRole("button", { name: /^Demandas$/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(2500);
  const depoisDoReload = await page.getByText(titulo, { exact: false }).count();
  record("a demanda sobrevive à recarga da página", depoisDoReload > 0, `${depoisDoReload} ocorrência(s)`);

  // E entrou na trilha: o produto promete auditoria de quem fez o quê.
  const auditoria = await page.evaluate(async () => {
    const resposta = await fetch("/api/workspace", { cache: "no-store" });
    const dados = await resposta.json();
    return (dados.recentActivity ?? []).slice(0, 8).map((item) => String(item.eventType ?? item.event_type ?? ""));
  }).catch(() => []);
  record("a criação entra na atividade recente",
    auditoria.some((evento) => /card/u.test(evento)), auditoria.slice(0, 3).join(", ") || "sem eventos");
}

// 4e. O site é encontrável (§45).
//
//     Medido contra o site de pé: antes desta correção /planos, /faq,
//     /privacidade e /termos declaravam a home como canônica — cada uma dizendo
//     ao buscador "sou cópia da home" —, e robots.txt e sitemap.xml davam 404.
{
  const canonicas = [];
  for (const caminho of ["", "planos", "faq", "privacidade", "termos", "solucao", "funcionalidades"]) {
    await page.goto(`${base}/${caminho}`, { waitUntil: "domcontentloaded" });
    const href = await page.locator('link[rel="canonical"]').first().getAttribute("href").catch(() => null);
    canonicas.push([caminho, href ?? ""]);
  }
  record("cada página declara a si mesma como canônica",
    canonicas.every(([caminho, href]) => caminho ? href.endsWith(`/${caminho}`) : /\/?$/u.test(href)),
    canonicas.map(([caminho, href]) => `${caminho || "/"}→${href.split("//")[1] ?? href}`).join(" "));

  const robots = await page.goto(`${base}/robots.txt`);
  const corpoRobots = robots ? await robots.text() : "";
  record("robots.txt responde e aponta o sitemap",
    robots?.status() === 200 && /Sitemap:/u.test(corpoRobots), `HTTP ${robots?.status()}`);
  record("robots.txt mantém a área logada fora do rastreio",
    /Disallow: \/painel/u.test(corpoRobots) && /Disallow: \/plataforma/u.test(corpoRobots));

  const sitemap = await page.goto(`${base}/sitemap.xml`);
  const corpoSitemap = sitemap ? await sitemap.text() : "";
  const urls = (corpoSitemap.match(/<url>/gu) ?? []).length;
  record("sitemap.xml lista as páginas públicas", sitemap?.status() === 200 && urls >= 10, `${urls} url(s)`);
  record("o sitemap não expõe área logada",
    !/\/painel|\/plataforma|\/login/u.test(corpoSitemap));
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
