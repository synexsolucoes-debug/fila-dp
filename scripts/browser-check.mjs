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
// `acceptDownloads` para conferir o CSV exportado: o arquivo é o único
// artefato do produto que sai do navegador e vai para a mão de alguém.
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR", acceptDownloads: true });
const page = await context.newPage();

const consoleErrors = [];
/* O console do Chromium relata falha de rede sem dizer qual pedido falhou: a
   mensagem é sempre "Failed to load resource…". Sem o endereço, a verificação
   acusa um defeito que ninguém consegue procurar — foi o que aconteceu aqui.
   `message.location()` carrega a URL do recurso; quando ela vem vazia, o
   registro das respostas ruins abaixo diz qual pedido estava em curso. */
const formatConsole = (message) => {
  const url = message.location()?.url ?? "";
  const texto = message.text().slice(0, 160);
  return url && !texto.includes(url) ? `${texto} [${url.replace(base, "")}]` : texto;
};

/**
 * Falha de recurso que a própria verificação provoca e já cobra por conta.
 *
 * O ambiente de verificação não tem armazenamento de anexos conectado, então o
 * envio do termo de entrega responde 503 — e o navegador registra a linha de
 * recurso no console. Isso não é erro de JavaScript, e o bloco do aplicativo de
 * campo cobra explicitamente o comportamento do produto nesse caso: a entrega
 * vale, o termo fica na fila, e a tela diz o motivo. A exceção é estreita de
 * propósito — esse status, nessa rota. Qualquer outra falha de recurso continua
 * reprovando, que é onde está o valor da verificação.
 */
const falhaProvocada = (message) => {
  const texto = message.text();
  if (!/Failed to load resource/u.test(texto) || !/\b503\b/u.test(texto)) return false;
  const url = message.location()?.url ?? "";
  // Sem URL no registro, o texto é a única pista; o 503 só nasce dessa rota
  // neste ensaio, e qualquer outro passaria a aparecer aqui para ser olhado.
  return url ? url.includes("/api/epi/attachments") : true;
};

page.on("console", (message) => {
  if (message.type() !== "error") return;
  if (falhaProvocada(message)) return;
  consoleErrors.push(formatConsole(message));
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 160)}`));

// Respostas de erro que o navegador recebeu, na ordem: é o rastro que
// transforma "algo deu 400" em "este pedido deu 400".
const respostasRuins = [];
page.on("response", (resposta) => {
  if (resposta.status() >= 400) {
    respostasRuins.push(`${resposta.status()} ${resposta.request().method()} ${resposta.url().replace(base, "")}`);
  }
});

/**
 * Abre um módulo do painel pelo menu de dois níveis (§25, §65).
 *
 * O menu agrupa os módulos pelo processo a que pertencem, e os do segundo
 * nível só existem no DOM enquanto o processo está aberto. Esta verificação
 * clicava direto em "Demandas" e "Relatórios" — que agora só aparecem depois
 * de abrir "Operação DP" e "Relatórios e integrações". Sem isto, sete
 * conferências reprovavam por não achar o botão, e nenhuma delas era sobre o
 * menu: eram sobre exportação de CSV e persistência de demanda.
 *
 * O caminho é o da pessoa: abre o processo, depois o módulo. Navegar por rota
 * seria mais curto e mediria menos — o painel troca de tela por estado, e um
 * atalho pularia justamente a navegação que o produto oferece.
 */
async function abrirModulo(processo, modulo) {
  const nav = "nav[aria-label='Navegação do painel']";
  await page.waitForSelector(`${nav} button`, { timeout: 25000 }).catch(() => undefined);
  await page.locator(`${nav} .sidebar-process > button`).filter({ hasText: processo }).first()
    .click().catch(() => undefined);
  await page.waitForTimeout(800);
  const submenu = page.locator(`${nav} .sidebar-process-view`).filter({ hasText: modulo });
  // Um processo recortado a um módulo só não tem segundo nível: entrar nele já
  // abriu o módulo, e não há submenu para clicar.
  if (await submenu.count() > 0) await submenu.first().click().catch(() => undefined);
}

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
  /* O preço exibido tem duas formas legítimas e nenhuma terceira.
     Ou o cartão mostra o valor do catálogo, ou declara que a condição é
     fechada em contrato ("Sob consulta") ou gratuita — e um plano negociado
     não pode mostrar número nenhum: o catálogo guarda um valor para o
     Enterprise porque a cobrança precisa dele, mas publicá-lo como preço
     fechado venderia uma condição que ninguém contratou assim.
     A conferência que importa é a terceira: nenhum cartão pode exibir um
     número que não esteja no catálogo. Era isso que a versão anterior media,
     e é isso que continua medido — agora sem obrigar todo plano pago a
     estampar o valor. */
  const prices = await page.locator(".plan-card .plan-price").allInnerTexts();
  const semPreco = /^(grátis|sob consulta)$/iu;
  const inventados = [];
  let comValorPublicado = 0;
  for (const [index, plan] of catalog.plans.entries()) {
    const mostrado = (prices[index] ?? "").split("\n")[0].trim();
    const reais = String(Math.trunc(plan.monthlyPriceCents / 100));
    if (semPreco.test(mostrado)) continue;
    if (mostrado.replace(/\s/gu, "").includes(reais) && plan.monthlyPriceCents > 0) {
      comValorPublicado += 1;
      continue;
    }
    inventados.push(`${plan.name}: "${mostrado}" ≠ catálogo ${reais}`);
  }
  record("nenhum cartão exibe preço fora do catálogo",
    inventados.length === 0,
    inventados.length > 0 ? inventados.join(" | ") : prices.map((price) => price.split("\n")[0]).join(" | "));
  record("ao menos um plano publica o preço do catálogo",
    comValorPublicado > 0,
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

  /* Endereços do painel (§43, §44, §74).
     O painel trocava de tela por estado e não tinha URL: não dava para mandar o
     link de uma demanda, voltar saía do produto e F5 perdia o contexto. Estas
     conferências medem o que HTTP não mede — o navegador de verdade fazendo
     F5, voltar e avançar. */
  await page.goto(`${base}/painel/ponto`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  record("deep link abre direto na tela pedida",
    new URL(page.url()).pathname === "/painel/ponto",
    `${new URL(page.url()).pathname} · ${(await page.locator("h1").first().innerText().catch(() => "")).slice(0, 30)}`);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  record("recarregar a página mantém o contexto",
    new URL(page.url()).pathname === "/painel/ponto", new URL(page.url()).pathname);

  await page.goto(`${base}/painel`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.goto(`${base}/painel/demandas`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.goBack({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const voltou = new URL(page.url()).pathname;
  await page.goForward({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  record("voltar e avançar navegam dentro do produto",
    voltou === "/painel" && new URL(page.url()).pathname === "/painel/demandas",
    `voltar=${voltou} avançar=${new URL(page.url()).pathname}`);

  /* As três centrais operacionais (§66, §90).
     A pergunta que estas conferências respondem é a da §92: uma pessoa abre o
     Vinculato, vê o que precisa fazer, e chega ao item certo. Se a Central
     abrir vazia por erro de consulta, ou se o filtro não recortar, isso só
     aparece no navegador — a rota devolveria 200 nos dois casos. */
  for (const [rota, titulo] of [
    ["/painel/trabalho", /está comigo hoje/iu],
    ["/painel/triagem", /não teve certeza/iu],
    ["/painel/agentes", /Automação sob controle/iu],
  ]) {
    await page.goto(`${base}${rota}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const cabecalho = await page.locator("h2, h1").allInnerTexts().catch(() => []);
    record(`${rota} abre com o próprio cabeçalho`,
      new URL(page.url()).pathname === rota && cabecalho.some((texto) => titulo.test(texto)),
      `${new URL(page.url()).pathname} · ${cabecalho.slice(0, 3).join(" | ").slice(0, 80)}`);
  }

  await page.goto(`${base}/painel/trabalho`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  record("a Central de Trabalho oferece escopo, tipo, prazo e ordenação (§6, §7)",
    await page.getByRole("button", { name: /^Meus itens$/u }).count() > 0
      && await page.getByRole("button", { name: /^Equipe$/u }).count() > 0
      && await page.locator("select").count() >= 4,
    `${await page.locator("select").count()} seletores`);

  record("os contadores da Central são clicáveis e filtram (§11)",
    await page.locator("button[aria-pressed]").count() >= 2,
    `${await page.locator("button[aria-pressed]").count()} indicadores`);

  // Trocar o escopo precisa recarregar do servidor, e não filtrar no navegador.
  // O que se mede é o **contrato**: a rota responde 200 e devolve a forma que a
  // tela consome. Contar erro de console mediria também o que aconteceu antes,
  // em outra tela — e acusaria a Central por defeito alheio.
  const antesDoEscopo = consoleErrors.length;
  await page.getByRole("button", { name: /^Equipe$/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(1500);
  const respostaDoTrabalho = await page.evaluate(async () => {
    const resposta = await fetch("/api/work?escopo=equipe", { cache: "no-store" });
    const dados = await resposta.json().catch(() => ({}));
    return {
      status: resposta.status,
      temItens: Array.isArray(dados.items),
      temContadores: Boolean(dados.counts) && typeof dados.counts.total === "number",
      erro: String(dados.error ?? dados.message ?? "").slice(0, 120),
    };
  }).catch(() => ({ status: 0, temItens: false, temContadores: false, erro: "sem resposta" }));
  record("a Central de Trabalho responde com itens e contadores (§11, §12)",
    respostaDoTrabalho.status === 200 && respostaDoTrabalho.temItens && respostaDoTrabalho.temContadores,
    `${respostaDoTrabalho.status} ${respostaDoTrabalho.erro}`);
  record("trocar o escopo não produz erro de JavaScript",
    consoleErrors.length === antesDoEscopo,
    consoleErrors.slice(antesDoEscopo, antesDoEscopo + 2).join(" | "));

  /* Fluxo completo: demanda → aba Processo (§66).
     A aba Processo é onde a consolidação inteira aparece para quem opera. Se ela
     abrir vazia, o vínculo existe no banco e não existe na tela — que é
     exatamente o estado que esta etapa veio corrigir.

     A demanda é aberta pelo **endereço dela**, e não por um clique no quadro:
     é o mesmo link que se manda para um colega, e abre a demanda certa em vez
     da primeira que o seletor encontrar. */
  const demanda = await page.evaluate(async () => {
    const resposta = await fetch("/api/workspace", { cache: "no-store" });
    const dados = await resposta.json().catch(() => ({}));
    const cartoes = (dados.lists ?? []).flatMap((lista) => lista.cards ?? []);
    return cartoes[0]?.id ?? "";
  }).catch(() => "");
  record("a semente tem demanda para abrir", Boolean(demanda), demanda || "nenhuma demanda");

  if (demanda) {
    await page.goto(`${base}/painel/demandas/${encodeURIComponent(demanda)}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const temAbaProcesso = await page.getByRole("button", { name: /^Processo$/u }).count() > 0;
    record("a demanda tem aba de Processo (§42)", temAbaProcesso);
    if (temAbaProcesso) {
      await page.getByRole("button", { name: /^Processo$/u }).first().click();
      await page.waitForTimeout(2000);
      const texto = await page.locator("[role=dialog]").first().innerText().catch(() => "");
      record("a aba de Processo diz a etapa ou explica por que não há processo (§42, §43)",
        /Etapa atual|não nasceu de um processo publicado/iu.test(texto),
        texto.replace(/\s+/gu, " ").slice(0, 100));
      record("a aba de Processo não exige leitura de BPMN (§43)",
        !/\bBPMN\b/u.test(texto), texto.replace(/\s+/gu, " ").slice(0, 60));
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(600);
  }

  await page.goto(`${base}/painel/configuracoes/seguranca`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  /* A Administração deixou de ser modal e virou tela. O endereço próprio
     continua sendo a exigência — é o link que se manda para alguém e o que
     sobrevive a um F5 —, e o que ele precisa abrir é a seção pedida, com o
     título dela. Conferir `[role=dialog]` passaria a cobrar a janela de volta. */
  record("as configurações têm endereço próprio",
    await page.locator("#admin-page-title").count() > 0
      && new URL(page.url()).pathname === "/painel/configuracoes/seguranca",
    `${new URL(page.url()).pathname} · ${await page.locator("#admin-page-title").innerText().catch(() => "sem título")}`);
  record("e abrem como tela, não como janela por cima do painel",
    await page.locator(".workspace-modal-backdrop").count() === 0);

  await page.goto(`${base}/painel`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  record("configurações têm porta na navegação, e não só atrás do avatar",
    await page.locator("aside button[aria-label='Abrir configurações']").count() > 0);

  // Endereço desconhecido não pune quem clicou num link antigo.
  await page.goto(`${base}/painel/secao-que-nao-existe`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  record("endereço desconhecido abre a visão geral em vez de 404",
    new URL(page.url()).pathname.startsWith("/painel"), new URL(page.url()).pathname);

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
  // Procura o workspace **pelo nome**, não pelo crescimento da contagem.
  //
  // "A tabela tem uma linha a mais" para de valer quando a lista pagina: num
  // banco com trinta clientes o novo entra na segunda página e a contagem da
  // primeira não muda. A conferência acusava falha de criação onde havia
  // criação — e o oposto também seria possível, já que outra linha qualquer
  // faria o número subir. O nome é o que prova que este workspace foi criado.
  const criado = page.getByText(`Cliente Navegador ${stamp}`, { exact: false });
  await criado.first().waitFor({ timeout: 20000 }).catch(() => undefined);
  const encontrado = await criado.count();
  const afterRows = await page.locator("table tbody tr").count();
  record("o workspace criado aparece na tabela", encontrado > 0,
    `${encontrado} ocorrência(s) de "Cliente Navegador ${stamp}" em ${afterRows} linha(s)`);

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

// 4a. A coluna de conteúdo do painel cabe na janela (§43, §94).
//
//     Este defeito não produz barra de rolagem: `.dashboard-shell` recorta com
//     `overflow: hidden`, então o excesso simplesmente deixa de existir para
//     quem está olhando. Medir `document.scrollWidth` — que é o que as outras
//     conferências de largura fazem — devolvia zero enquanto 140px de conteúdo
//     eram cortados em 1280×720.
//
//     A causa foi `min-width: auto`, o valor inicial de um item de grade: a
//     coluna do shell é `minmax(0, 1fr)` para poder encolher, e o item dentro
//     dela se recusava. Só aparece nas resoluções que a §43 lista como alvo —
//     em 1920 sobra largura e o defeito some, que é por que ele durou.
if (password) {
  for (const [width, height] of [[1366, 768], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    const medir = async () => page.evaluate(() => {
      const main = document.querySelector("section.dashboard-main");
      return main ? main.scrollWidth - main.clientWidth : -1;
    });
    // A home e um processo: em 1366 a home cabia e o cockpit de fechamento
    // não, então medir só a primeira tela deixaria metade do defeito passar.
    let corte = await medir();
    await abrirModulo("Operação DP", "Visão geral");
    await page.waitForTimeout(1400);
    corte = Math.max(corte, await medir());
    record(`o painel não corta conteúdo em ${width}x${height}`, corte >= 0 && corte <= 2, `${corte}px além da coluna`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
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
  // Mira o indicador pelo que ele e, nao pelo elemento que o desenha nem pela
  // ordem em que aparece: o seletor por tipo de elemento mais `.first()` ja
  // apontou para o cartao errado quando os indicadores viraram botao, e a
  // conferencia do recorte passou a comparar 0 com 0.
  await page.waitForSelector('[data-metric="demands-open"] strong', { timeout: 25000 }).catch(() => undefined);
  await page.waitForTimeout(1200);

  const chamadas = [];
  const escuta = (request) => { if (request.url().includes("action-center")) chamadas.push(request.url()); };
  page.on("request", escuta);

  const abertasNoGrupo = Number((await page.locator('[data-metric="demands-open"] strong').innerText().catch(() => "0")).trim());
  const seletor = page.getByLabel("Selecionar empresa");
  const valores = await seletor.locator("option").evaluateAll((options) => options.map((option) => option.value));
  const vazia = valores.find((value) => value.startsWith("co-ui-2"));

  if (!vazia) {
    record("a semente tem uma empresa sem demanda para provar o recorte", false, valores.join(", "));
  } else {
    await seletor.selectOption(vazia);
    await page.waitForTimeout(1800);
    const abertasNaFilial = Number((await page.locator('[data-metric="demands-open"] strong').innerText().catch(() => "-1")).trim());
    record("escolher empresa recorta os indicadores da visão geral",
      abertasNoGrupo > 0 && abertasNaFilial === 0, `grupo ${abertasNoGrupo} → filial sem demanda ${abertasNaFilial}`);

    /* O rótulo do recorte já migrou duas vezes: da faixa "RESUMO OPERACIONAL"
       para o cabeçalho da competência, e agora para o nome da própria faixa de
       indicadores — a competência saiu da Visão geral com a maquete. O lugar
       mudou; a exigência é a de sempre: "3 demandas" com uma empresa escolhida
       e "3" com o grupo inteiro são o mesmo texto para fatos diferentes. */
    const resumo = await page.locator(".overview-kpis").getAttribute("aria-label").catch(() => "");
    record("a visão geral diz de quem são os números",
      /Filial Vazia/iu.test(resumo ?? ""), resumo ?? "");
  }
  page.off("request", escuta);
  await seletor.selectOption("all").catch(() => undefined);

  /* A central de ação mudou de tela: saiu da Visão geral, que a maquete refez
     com quatro blocos, e passou para "Meu trabalho". A exigência continua
     sendo que ela consulte o servidor com a empresa escolhida — a rota sempre
     aceitou `companyId` e conferia o acesso; era o painel que não enviava. */
  if (vazia) {
    const chamadasTrabalho = [];
    const escutaTrabalho = (request) => {
      if (request.url().includes("/api/dashboard/action-center")) chamadasTrabalho.push(request.url());
    };
    page.on("request", escutaTrabalho);
    await page.goto(`${base}/painel/trabalho`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await page.getByLabel("Selecionar empresa").selectOption(vazia).catch(() => undefined);
    await page.waitForTimeout(2000);
    page.off("request", escutaTrabalho);
    const ultima = chamadasTrabalho[chamadasTrabalho.length - 1] ?? "";
    record("a central de ação consulta o servidor com a empresa escolhida",
      ultima.includes(`companyId=${vazia}`), ultima.slice(-70) || "nenhuma chamada");
    await page.getByLabel("Selecionar empresa").selectOption("all").catch(() => undefined);
  }
}

// 4d. Relatórios e a exportação seguem o recorte de empresa.
//
//     O CSV é o pior caso do filtro ignorado: a tela mostrando o grupo inteiro
//     é confuso; um arquivo com o grupo inteiro, baixado logo depois de
//     escolher uma empresa, sai daqui parecendo ser daquela empresa.
if (password) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await abrirModulo("Relatórios e integrações", "Relatórios");
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
  await abrirModulo("Operação DP", "Demandas");
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
  await abrirModulo("Operação DP", "Demandas");
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

// 4g. O console não oferece a ação que o servidor vai recusar (§31).
//
//     O conector Sankhya é criado em todo workspace pela migration 0038, mas o
//     módulo não entra em plano nenhum: a liberação é individual, feita pela
//     plataforma. O console listava o cartão assim mesmo, com "Executar",
//     "Retry" e "Configurar" — e o servidor recusava depois. Na configuração, a
//     recusa chegava com o formulário já preenchido com endereço, usuário e
//     senha do cliente.
//
//     Nenhuma conferência via, porque nenhuma abria a área de Integrações do
//     console. A semente deixa o módulo fechado, que é justamente o estado
//     normal de um workspace novo — então é este o estado que se mede aqui.
if (password) {
  await page.setViewportSize({ width: 1440, height: 900 });
  // O cartão é reconhecido pelo canal, e não pelo nome exibido: o nome é
  // decisão de produto e já mudou uma vez ("Sankhya Browser Connector" virou
  // "Agente Sankhya"). Amarrar a verificação ao rótulo faz a renomeação seguinte
  // quebrar o ensaio em vez de o produto.
  const sankhya = () => page.locator("article").filter({ hasText: /SANKHYA_BROWSER/u });

  // Estado liberado: o workspace da semente tem a concessão. Filtrar por ele em
  // vez de contar com a ordenação — cada execução desta conferência cria um
  // cliente novo, e depois de trinta a primeira página não teria mais a semente.
  await page.goto(`${base}/plataforma?area=integrations&workspace=ws-ui`, { waitUntil: "domcontentloaded" });
  const liberado = sankhya().first();
  await liberado.waitFor({ timeout: 25000 }).catch(() => undefined);
  const achouLiberado = await liberado.count();
  record("o console lista o conector Sankhya do workspace liberado", achouLiberado > 0);
  if (achouLiberado) {
    const texto = await liberado.innerText().catch(() => "");
    record("com o módulo liberado, configurado e conectado, o cartão oferece a execução",
      !/não liberado/u.test(texto) && await liberado.getByRole("button", { name: /Executar/u }).count() > 0,
      texto.replace(/\n/gu, " · ").slice(0, 90));
    // O degrau seguinte só aparece quando o anterior falta: um cartão já
    // conectado oferecendo "Testar conexão" seria a escada lida ao contrário.
    record("e não repete o degrau anterior quando já está conectado",
      await liberado.getByRole("button", { name: /Testar conexão/u }).count() === 0);

    // E o formulário de configuração está lá — sem isto, o estado bloqueado
    // medido logo abaixo passaria também num painel que nunca abre formulário.
    await liberado.getByRole("button", { name: /Configurar/u }).first().click().catch(() => undefined);
    await page.waitForSelector('[role="dialog"]', { timeout: 20000 }).catch(() => undefined);
    const painelLiberado = page.locator('[role="dialog"]');
    await painelLiberado.locator('input[type="url"]').first().waitFor({ timeout: 20000 }).catch(() => undefined);
    record("o painel do módulo liberado abre o formulário de configuração",
      await painelLiberado.locator('input[type="url"]').count() > 0
      && await painelLiberado.locator('input[type="password"]').count() > 0);
    await page.getByRole("button", { name: /^Fechar$/u }).first().click().catch(() => undefined);
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10000 }).catch(() => undefined);
  }

  // Estado bloqueado: qualquer workspace sem a concessão — inclusive o que a
  // seção 3 acabou de criar, que é o caso real de um cliente recém-provisionado.
  /* Filtrado pelo conector, e não a lista inteira.
     A lista traz 30 conectores por página, e todo workspace tem um de cada
     canal — então "o cartão do workspace novo está na primeira página" depende
     de **quantos canais existem**, que é decisão de produto e muda. Foi o que
     aconteceu ao provisionar o Agente Tangerino: três workspaces passaram a
     encher a página exata, e o cartão medido aqui caiu para a segunda. A
     verificação passa a pedir o que ela mede. */
  await page.goto(`${base}/plataforma?area=integrations&connector=sankhya_browser`, { waitUntil: "domcontentloaded" });
  await sankhya().first().waitFor({ timeout: 25000 }).catch(() => undefined);
  const bloqueado = sankhya().filter({ hasText: /não liberado/u }).first();
  const achouBloqueado = await bloqueado.count();
  record("o cartão de um workspace sem liberação diz que o módulo está fechado",
    achouBloqueado > 0, `${await sankhya().count()} cartão(ões) Sankhya na página`);

  if (achouBloqueado) {
    const oferecidas = await bloqueado.getByRole("button", { name: /Executar|Retry/u }).count();
    record("e para de oferecer executar e testar enquanto está bloqueado",
      oferecidas === 0, `${oferecidas} botão(ões) de execução`);

    // O defeito relatado terminava aqui: o formulário abria inteiro, aceitava
    // endereço, usuário e senha, e só ao salvar o servidor recusava.
    await bloqueado.getByRole("button", { name: /Detalhes/u }).first().click().catch(() => undefined);
    await page.waitForSelector('[role="dialog"]', { timeout: 20000 }).catch(() => undefined);
    const painel = page.locator('[role="dialog"]');
    await painel.getByRole("heading", { name: /Configuração Sankhya do workspace/u }).first()
      .waitFor({ timeout: 20000 }).catch(() => undefined);
    const textoPainel = await painel.innerText().catch(() => "");
    record("o painel não abre o formulário que o servidor vai recusar",
      await painel.locator('input[type="url"], input[type="password"]').count() === 0,
      `${await painel.locator("input").count()} campo(s) no painel`);
    record("e diz o que destrava, com a frase do próprio servidor",
      /não faz parte de nenhum plano/u.test(textoPainel) && /Acessos e módulos/u.test(textoPainel),
      textoPainel.replace(/\n/gu, " · ").slice(0, 120));
    record("o painel bloqueado também leva até a liberação",
      await painel.getByRole("button", { name: /Liberar módulo/u }).count() > 0);
    await page.getByRole("button", { name: /^Fechar$/u }).first().click().catch(() => undefined);
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10000 }).catch(() => undefined);

    const liberar = bloqueado.getByRole("button", { name: /Liberar módulo/u });
    const temPorta = await liberar.count();
    record("informar sem porta seria o mesmo beco: o cartão leva à liberação", temPorta > 0);

    if (temPorta) {
      await liberar.first().click();
      await page.waitForFunction(() => new URLSearchParams(location.search).get("area") === "operations",
        undefined, { timeout: 20000 }).catch(() => undefined);
      const destino = new URL(page.url());
      record("a porta abre a configuração do workspace certo",
        destino.searchParams.get("area") === "operations" && Boolean(destino.searchParams.get("workspace")),
        destino.search.slice(0, 100));

      await page.waitForSelector('[role="tab"]', { timeout: 25000 }).catch(() => undefined);
      const abas = await page.locator('[role="tab"]').allInnerTexts().catch(() => []);
      record("e a aba citada na recusa existe mesmo",
        abas.some((aba) => /Acessos e módulos/u.test(aba)), abas.join(" | ").slice(0, 100));

      // Liberar de verdade, e voltar: o estado seguinte é o que produziu o
      // segundo relato — módulo liberado, configuração ainda não gravada, e o
      // cartão oferecendo "Executar" sobre ela. A recusa do servidor chegava
      // como "Configure a URL e a empresa de destino" logo depois de alguém ter
      // preenchido o formulário e tido a gravação recusada sem perceber.
      const workspaceLiberado = destino.searchParams.get("workspace") ?? "";
      await page.locator('[role="tab"]').filter({ hasText: /Acessos e módulos/u }).first().click().catch(() => undefined);
      const linhaModulo = page.locator("form").filter({ hasText: /Sankhya/u }).first();
      await linhaModulo.waitFor({ timeout: 25000 }).catch(() => undefined);
      await linhaModulo.locator("select").selectOption("allow").catch(() => undefined);
      await linhaModulo.getByRole("button", { name: /Revisar/u }).click().catch(() => undefined);
      await page.waitForSelector('form[role="dialog"]', { timeout: 20000 }).catch(() => undefined);
      await page.locator('form[role="dialog"] textarea').first().fill("Ensaio automatizado de liberação do módulo.").catch(() => undefined);
      await page.locator('form[role="dialog"]').getByRole("button", { name: /Confirmar alteração/u }).click().catch(() => undefined);
      await page.waitForSelector('form[role="dialog"]', { state: "detached", timeout: 25000 }).catch(() => undefined);

      await page.goto(`${base}/plataforma?area=integrations&workspace=${encodeURIComponent(workspaceLiberado)}`,
        { waitUntil: "domcontentloaded" });
      const recemLiberado = sankhya().first();
      await recemLiberado.waitFor({ timeout: 25000 }).catch(() => undefined);
      const textoLiberado = await recemLiberado.innerText().catch(() => "");
      record("liberar o módulo pela interface tira o cartão do estado bloqueado",
        !/não liberado/u.test(textoLiberado), textoLiberado.replace(/\n/gu, " · ").slice(0, 90));
      record("mas o cartão sem configuração gravada diz isso, em vez de oferecer executar",
        /Configuração incompleta/u.test(textoLiberado)
        && await recemLiberado.getByRole("button", { name: /Executar|Retry/u }).count() === 0,
        `${await recemLiberado.getByRole("button", { name: /Executar|Retry/u }).count()} botão(ões) de execução`);
    }
  }
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

// Cadastro de EPI de ponta a ponta.
//
// Existe por um defeito que passou por typecheck, lint e a bateria inteira de
// testes e chegou ao cliente: o formulário de EPI novo mandava um campo
// obrigatório vazio, e o servidor recusava com "Informe a empresa." sem que a
// tela oferecesse onde corrigir. A causa mudou desde então — o cadastro passou
// a ser do grupo —, mas a classe do defeito não: **o formulário que a tela
// apresenta precisa ser um que o servidor aceite**, e isso só se mede
// preenchendo.
//
// Nenhuma verificação estática alcança isso. O payload só fica errado quando
// alguém digita.
{
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/painel`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Navegação do painel'] button", { timeout: 25000 }).catch(() => undefined);
  /* O menu tem dois níveis desde que passou a agrupar por processo (§25): o
     primeiro é o processo, o segundo são os módulos dele. Clicar direto no
     módulo encontrava um botão de um processo já aberto e não levava a lugar
     nenhum — a tela continuava na home, e as três conferências abaixo
     reprovavam dizendo que o EPI não tinha ação de cadastro, quando o que
     faltava era ter chegado até ele. */
  await page.getByRole("button", { name: /^Gestão de EPI$/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^Controle de EPI$/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(2000);

  const abriu = await page.getByRole("button", { name: /Cadastrar EPI/u }).count();
  record("o Controle de EPI abre com a ação de cadastro", abriu > 0, `${abriu} botão(ões)`);

  await page.getByRole("button", { name: /Cadastrar EPI/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(900);
  const gaveta = page.getByRole("dialog");
  record("o formulário de novo EPI abre", await gaveta.count() > 0);

  // Todo campo obrigatório da gaveta precisa ser preenchível pela tela. Um
  // `required` que a pessoa não consegue satisfazer é a assinatura do defeito.
  const obrigatoriosOcultos = await gaveta.locator('[required]:not(:visible)').count().catch(() => 0);
  record("nenhum campo obrigatório do EPI está fora do alcance de quem preenche",
    obrigatoriosOcultos === 0, `${obrigatoriosOcultos} campo(s) obrigatório(s) oculto(s)`);

  const ca = `CA-ENSAIO-${Date.now().toString().slice(-6)}`;
  await gaveta.locator('input[name="name"]').fill("Capacete de segurança").catch(() => undefined);
  await gaveta.locator('input[name="caNumber"]').fill(ca).catch(() => undefined);
  await gaveta.locator('input[name="size"]').fill("Único").catch(() => undefined);
  await gaveta.locator('input[name="brand"]').fill("Marca do ensaio").catch(() => undefined);
  await gaveta.locator('input[name="model"]').fill("Modelo do ensaio").catch(() => undefined);
  await gaveta.locator('input[name="unitValue"]').fill("48.90").catch(() => undefined);
  await gaveta.locator('input[name="stockQuantity"]').fill("12").catch(() => undefined);
  await gaveta.locator('textarea[name="notes"]').fill("Criado pela verificação de navegador.").catch(() => undefined);
  await gaveta.getByRole("button", { name: /Cadastrar EPI/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(3000);

  const recusa = await page.getByRole("dialog").getByRole("alert").count();
  const motivo = recusa ? (await page.getByRole("dialog").getByRole("alert").first().innerText()).replace(/\s+/gu, " ").slice(0, 140) : "";
  record("o servidor aceita o cadastro que a tela montou", recusa === 0, motivo);

  /* O cadastro devolve para a visão geral, e o produto novo mora no estoque.
     Procurar o CA sem trocar de aba media a tela errada: o EPI existia, e a
     conferência dizia que não.

     A aba é procurada pelo papel `tab`, e não `button`: ela é um `<button>` no
     HTML, mas com `role="tab"` — e é o papel ARIA, não a etiqueta, que o
     `getByRole` enxerga. A âncora do fim também sai do padrão, porque o nome
     acessível carrega o contador: é "Estoque 5", não "Estoque". */
  await page.getByRole("tab", { name: /^Estoque/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(2500);
  const naListagem = await page.getByText(ca, { exact: false }).count();
  record("o EPI cadastrado aparece no estoque", naListagem > 0, `${naListagem} ocorrência(s)`);
}

// Aplicativo de campo (/campo) — entrega com assinatura, em 390px.
//
// É a mesma razão do bloco acima, levada ao fluxo que acontece longe da mesa.
// A tela de campo debita estoque, colhe assinatura e anexa o termo; nada disso
// se prova sem passar pelos passos como quem está no galpão passa. E há uma
// armadilha específica aqui: o saldo exibido tem de ser o do local escolhido,
// porque a entrega debita um local só — mostrar o total do grupo ofereceria
// unidades que não estão ali, e a recusa chegaria depois da assinatura.
{
  await page.setViewportSize({ width: 390, height: 844 });

  // O preparo usa as rotas reais do produto: um colaborador e um EPI próprios,
  // com selo no nome, para o ensaio não depender de dado de outra execução.
  const stamp = Date.now().toString().slice(-6);
  const employeeName = `Joana de Campo ${stamp}`;
  const setup = await page.evaluate(async ({ stamp, employeeName }) => {
    const post = async (url, body) => {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json().catch(() => ({})) };
    };
    const companies = await (await fetch("/api/companies")).json();
    const company = (companies.companies ?? []).find((item) => item.status === "active") ?? companies.companies?.[0];
    const places = await (await fetch("/api/epi/stock/locations")).json();
    const location = (places.locations ?? [])[0];
    const employee = await post("/api/employees", {
      companyId: company?.id, registrationNumber: `MC-${stamp}`, fullName: employeeName,
      admissionDate: "2026-01-15", employmentStatus: "active",
    });
    const product = await post("/api/epi/products", {
      name: "Luva de proteção mecânica", epiType: "upper_limbs", caNumber: `CA-CAMPO-${stamp}`,
      size: "G", brand: "Marca do ensaio", model: "Modelo do ensaio", unitValue: 23.5,
      stockQuantity: 10, stockLocationId: location?.id, internalCode: `INT-CAMPO-${stamp}`,
      // Catálogo é "ativo/inativo": `in_stock` é estado de peça, não de modelo,
      // e o CHECK da 0062 recusa o vocabulário trocado.
      registeredOn: new Date().toISOString().slice(0, 10), status: "active",
      registrationReason: "initial_purchase", notes: "Criado pela verificação de navegador.",
    });
    // Roteamento SESMT → DP. A análise de desconto abre demanda, e o produto
    // exige uma área ativa responsável antes de abrir — com razão: demanda sem
    // dono fica sem quem responda. Sem configurar isto, o passo do dano reprova
    // por falta de preparo e não por defeito.
    const areasPayload = await (await fetch("/api/areas")).json();
    const areas = areasPayload.areas ?? [];
    const comRoteamento = areas.find((item) =>
      (item.module_keys ?? []).includes("epi.discount_analysis"));
    let roteamento = comRoteamento ? 200 : 0;
    if (!comRoteamento) {
      const alvo = areas.find((item) => item.status === "active") ?? areas[0];
      const chaves = ["epi.owner", "epi.discount_analysis"];
      if (alvo) {
        const response = await fetch(`/api/areas/${alvo.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: alvo.name, code: alvo.code, description: alvo.description ?? "",
            managerUserId: alvo.manager_user_id ?? "", color: alvo.color ?? "#475569",
            icon: alvo.icon ?? "building-2", defaultSlaDays: alvo.default_sla_days ?? 3,
            status: "active",
            moduleKeys: [...new Set([...(alvo.module_keys ?? []), ...chaves])],
          }),
        });
        roteamento = response.status;
      } else {
        const response = await fetch("/api/areas", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "SESMT do ensaio", code: `SESMT${stamp}`, moduleKeys: chaves }),
        });
        roteamento = response.status;
      }
    }

    return { company: company?.id, location: location?.id, employee, product, roteamento };
  }, { stamp, employeeName });
  record("o preparo do ensaio de campo cria colaborador e EPI pelas rotas do produto",
    setup.employee.status === 201 && setup.product.status === 201,
    `colaborador ${setup.employee.status} · EPI ${setup.product.status}`);
  record("o roteamento SESMT → DP está configurado para a análise de desconto",
    setup.roteamento === 200 || setup.roteamento === 201, `HTTP ${setup.roteamento}`);

  await page.goto(`${base}/campo`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  record("o aplicativo de campo abre com as ações do turno",
    await page.getByRole("button", { name: /Entregar EPI/u }).count() > 0);
  const campoOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record("o aplicativo de campo não rola na horizontal em 390px", campoOverflow <= 1, `sobra ${campoOverflow}px`);
  record("o aplicativo de campo é instalável (manifesto servido)",
    await page.evaluate(async () => (await fetch("/manifest.webmanifest")).ok));

  // Empresa e local são escolhidos de propósito: o padrão da tela vem da ordem
  // do painel geral, que não é a ordem usada no preparo.
  await page.getByLabel("EMPRESA").selectOption(setup.company).catch(() => undefined);
  await page.getByLabel("LOCAL DE ESTOQUE").selectOption(setup.location).catch(() => undefined);
  await page.getByRole("button", { name: /Entregar EPI/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);

  await page.getByLabel("Buscar colaborador").fill(employeeName).catch(() => undefined);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  const naLista = page.getByRole("button", { name: new RegExp(employeeName, "u") });
  if (await naLista.count()) await naLista.first().click();
  await page.waitForTimeout(1500);
  record("a busca de colaborador em campo acha quem acabou de ser admitido",
    await page.getByRole("heading", { name: /Qual EPI\?/u }).count() > 0);

  // A lista inicial mostra o saldo do local. Confere-se antes de buscar: busca
  // com um só resultado avança sozinha e a lista sai da tela.
  record("o saldo exibido em campo é o do local escolhido, não o total do grupo",
    await page.getByText(/neste local/u).count() > 0);

  const internalCode = setup.product.data?.product?.internalCode ?? "";
  await page.getByLabel("Buscar EPI").fill(internalCode).catch(() => undefined);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  record("o EPI é encontrado pelo código interno, como no crachá da etiqueta",
    await page.getByText("Luva de proteção mecânica").count() > 0, internalCode);

  const canvas = page.locator('canvas[aria-label="Área de assinatura do colaborador"]');
  if (await canvas.count()) {
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 90);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 50, { steps: 8 });
    await page.mouse.move(box.x + 200, box.y + 120, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    record("a assinatura no dedo registra traço no campo de assinatura",
      await page.getByText("Assinatura capturada").count() > 0);
  } else record("a assinatura no dedo registra traço no campo de assinatura", false, "canvas ausente");

  await page.getByRole("button", { name: /Confirmar entrega/u }).first().click().catch(() => undefined);
  // O recado da tela vive pouco mais de quatro segundos: espera-se o elemento,
  // não o relógio, para não ler a tela depois que o aviso saiu.
  const aviso = page.locator('[role="status"]').filter({ hasText: /registrada|guardada|não subiu/u }).first();
  const recado = await aviso.innerText({ timeout: 20000 })
    .then((text) => text.replace(/\s+/gu, " ").trim()).catch(() => "");
  record("a tela de campo confirma o que aconteceu com a entrega", recado.length > 0, recado.slice(0, 140));

  const proof = await page.evaluate(async ({ employeeId, productId, code }) => {
    const deliveries = await (await fetch(`/api/epi/deliveries?employeeId=${employeeId}&limit=10`)).json();
    const delivery = (deliveries.deliveries ?? []).find((row) => row.product_id === productId);
    const attachments = delivery
      ? await (await fetch(`/api/epi/attachments?entityType=delivery&entityId=${delivery.id}`)).json()
      : null;
    const products = await (await fetch(`/api/epi/products?search=${encodeURIComponent(code)}&limit=5`)).json();
    return {
      status: delivery?.status,
      signature: delivery?.signature_name,
      kinds: (attachments?.attachments ?? []).map((item) => item.attachment_kind),
      balance: (products.products ?? [])[0]?.available_quantity,
    };
  }, {
    employeeId: setup.employee.data?.employee?.id,
    productId: setup.product.data?.product?.id,
    code: internalCode,
  });
  record("a entrega feita em campo chega ao banco como termo assinado",
    proof.status === "signed" && proof.signature === employeeName,
    `status ${proof.status} · assinatura ${proof.signature}`);
  record("a entrega em campo debita o estoque do local de 10 para 9",
    Number(proof.balance) === 9, `saldo ${proof.balance}`);

  // O anexo depende de armazenamento de Blob conectado ao projeto. Onde ele
  // existe, o termo tem de estar lá. Onde não existe — o ambiente de CI é um —,
  // o que se cobra é o comportamento que o produto promete nessa situação: a
  // entrega vale, o termo fica na fila, e a tela diz isso em vez de mandar
  // colher a assinatura de novo. Pular a verificação em silêncio deixaria o
  // caminho mais delicado do aplicativo sem nenhuma prova.
  if (proof.kinds.includes("delivery_term")) {
    record("o termo assinado fica anexado à entrega", true);
  } else {
    record("sem armazenamento de anexos, a tela diz que só o termo ficou pendente",
      /não subiu/u.test(recado), recado.slice(0, 140));
    await page.getByRole("button", { name: /aguardando envio/u }).first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    const queueText = (await page.locator("body").innerText()).replace(/\s+/gu, " ");
    record("a fila de campo separa registro pendente de evidência pendente",
      /Registro já gravado no servidor/u.test(queueText), queueText.slice(0, 160));
    record("o motivo da falha do anexo chega à tela, e não só ao log",
      /armazenamento de anexos não está configurado/u.test(queueText), queueText.slice(0, 160));
  }

  // Consulta: o que está em poder de quem. É a tela que o técnico abre antes de
  // entregar, para não entregar o que a pessoa já tem.
  await page.goto(`${base}/campo`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.getByLabel("EMPRESA").selectOption(setup.company).catch(() => undefined);
  await page.getByLabel("LOCAL DE ESTOQUE").selectOption(setup.location).catch(() => undefined);
  await page.getByRole("button", { name: /Consultar colaborador/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  await page.getByLabel("Buscar colaborador").fill(employeeName).catch(() => undefined);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const consulta = (await page.locator("body").innerText()).replace(/\s+/gu, " ");
  record("a consulta em campo mostra o EPI que está em poder do colaborador",
    consulta.includes("Luva de proteção mecânica"), consulta.slice(0, 160));

  // Devolução: a condição escolhida é o que decide o destino do equipamento.
  // "Devolvido higienizado" devolve ao estoque do local, e é isso que se mede —
  // o saldo voltar a 10 prova que a condição foi aplicada, não só gravada.
  await page.goto(`${base}/campo`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.getByLabel("EMPRESA").selectOption(setup.company).catch(() => undefined);
  await page.getByLabel("LOCAL DE ESTOQUE").selectOption(setup.location).catch(() => undefined);
  await page.getByRole("button", { name: /Receber devolução/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  await page.getByLabel("Buscar colaborador").fill(employeeName).catch(() => undefined);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Luva de proteção mecânica/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(1000);
  await page.getByRole("radio", { name: /^Devolvido higienizado$/u }).first().click().catch(() => undefined);
  await page.getByRole("button", { name: /Confirmar devolução/u }).first().click().catch(() => undefined);
  const avisoDevolucao = await page.locator('[role="status"]').filter({ hasText: /registrada|guardada/u })
    .first().innerText({ timeout: 20000 }).then((t) => t.replace(/\s+/gu, " ").trim()).catch(() => "");
  record("a devolução feita em campo é confirmada na tela", avisoDevolucao.length > 0, avisoDevolucao.slice(0, 140));

  const aposDevolucao = await page.evaluate(async ({ code, employeeId }) => {
    const products = await (await fetch(`/api/epi/products?search=${encodeURIComponent(code)}&limit=5`)).json();
    const returns = await (await fetch(`/api/epi/returns?employeeId=${employeeId}&limit=5`)).json();
    return {
      balance: (products.products ?? [])[0]?.available_quantity,
      condition: (returns.returns ?? [])[0]?.epi_condition,
    };
  }, { code: internalCode, employeeId: setup.employee.data?.employee?.id });
  record("a devolução higienizada devolve a unidade ao estoque do local",
    Number(aposDevolucao.balance) === 10, `saldo ${aposDevolucao.balance}`);
  record("a condição escolhida na tela é a que fica gravada",
    aposDevolucao.condition === "returned_sanitized", `condição ${aposDevolucao.condition}`);

  // Dano com foto. Precisa de algo em poder do colaborador, e a devolução acima
  // devolveu tudo — então a entrega de apoio vem pela API, como o preparo.
  const apoio = await page.evaluate(async ({ companyId, locationId, productId, employeeId }) => {
    const response = await fetch("/api/epi/deliveries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyId, productId, employeeId, stockLocationId: locationId,
        deliveredOn: new Date().toISOString().slice(0, 10), quantity: 1,
        deliveryReason: "first_delivery", status: "pending_signature",
      }),
    });
    return response.status;
  }, {
    companyId: setup.company, locationId: setup.location,
    productId: setup.product.data?.product?.id,
    employeeId: setup.employee.data?.employee?.id,
  });
  record("a entrega de apoio ao ensaio de dano é aceita", apoio === 201, `HTTP ${apoio}`);

  // A evidência entra por `<input type="file">`, que é o mesmo caminho da câmera
  // do aparelho — `setInputFiles` entrega o arquivo que a câmera entregaria.
  await page.goto(`${base}/campo`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.getByLabel("EMPRESA").selectOption(setup.company).catch(() => undefined);
  await page.getByLabel("LOCAL DE ESTOQUE").selectOption(setup.location).catch(() => undefined);
  await page.getByRole("button", { name: /Registrar dano/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  await page.getByLabel("Buscar colaborador").fill(employeeName).catch(() => undefined);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Luva de proteção mecânica/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(1000);

  // PNG mínimo válido, montado aqui: o ensaio não depende de arquivo no disco.
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64");
  await page.locator('input[type="file"]').first()
    .setInputFiles({ name: "dano.png", mimeType: "image/png", buffer: pixel }).catch(() => undefined);
  await page.waitForTimeout(500);
  record("a foto da evidência é aceita e anunciada na tela",
    await page.getByText(/Foto anexada à ocorrência/u).count() > 0);

  // A descrição é obrigatória no servidor. A tela precisa cobrar antes de
  // mandar — é a classe de defeito que já chegou ao cliente neste módulo.
  // O botão de gravar se chama "Registrar dano", como a ação da tela inicial —
  // daí a busca pelo último, que é o da barra de ação deste passo.
  const gravarDano = page.getByRole("button", { name: /^Registrar dano$/u }).last();
  await gravarDano.click().catch(() => undefined);
  await page.waitForTimeout(1200);
  const semDescricao = await page.locator('[role="alert"]').filter({ hasText: /Descreva/u }).count();
  record("a tela cobra a descrição do dano antes de mandar ao servidor", semDescricao > 0);

  await page.locator("textarea").first().fill("Luva rasgada no manuseio de chapa durante o turno.").catch(() => undefined);
  // Motivo e decisão são listas com papel de rádio, não botões: a tela diz o que
  // cada controle é, e a verificação precisa pedir pelo papel certo.
  await page.getByRole("radio", { name: /^Uso inadequado$/u }).first().click().catch(() => undefined);
  await page.getByRole("radio", { name: /^Enviar para análise de desconto$/u }).first().click().catch(() => undefined);
  await page.waitForTimeout(400);
  // A consequência precisa estar escrita antes de confirmar, e precisa dizer
  // que nada é descontado ali — é a regra que governa o módulo.
  const consequencia = (await page.locator("body").innerText()).replace(/\s+/gu, " ");
  record("a tela avisa que a análise de desconto é demanda do DP, e não desconto",
    /Nenhum valor é descontado aqui/u.test(consequencia));

  await gravarDano.click().catch(() => undefined);
  const avisoDano = await page.locator('[role="status"]').filter({ hasText: /registrado|guardada|não subiu/u })
    .first().innerText({ timeout: 20000 }).then((t) => t.replace(/\s+/gu, " ").trim()).catch(() => "");
  // Quando falha, o que interessa é o motivo: a recusa do servidor aparece no
  // banner do fluxo, e sem ela a reprovação manda alguém procurar no escuro.
  const recusaDano = await page.locator('[role="alert"]').filter({ hasText: /\S/u }).first()
    .innerText().then((t) => t.replace(/\s+/gu, " ").trim()).catch(() => "");
  record("o dano registrado em campo é confirmado na tela", avisoDano.length > 0,
    avisoDano.slice(0, 140) || recusaDano.slice(0, 180));

  const danoNoBanco = await page.evaluate(async ({ employeeId }) => {
    const payload = await (await fetch(`/api/epi/damages?employeeId=${employeeId}&limit=5`)).json();
    const row = (payload.damages ?? [])[0];
    const discounts = await (await fetch("/api/epi/discounts?limit=5")).json();
    return {
      motivo: row?.damage_reason,
      decisao: row?.decision,
      // `demand_title` é o título do cartão de demanda que a análise abriu — é
      // ali que a regra do módulo se verifica, não num campo da própria
      // solicitação.
      titulos: (discounts.discounts ?? []).map((item) => String(item.demand_title ?? "")),
    };
  }, { employeeId: setup.employee.data?.employee?.id });
  record("o dano chega ao banco com o motivo e a decisão escolhidos",
    danoNoBanco.motivo === "misuse" && danoNoBanco.decisao === "send_to_discount_analysis",
    `motivo ${danoNoBanco.motivo} · decisão ${danoNoBanco.decisao}`);
  record("a decisão de análise abre a demanda de desconto com o título da regra",
    danoNoBanco.titulos.some((titulo) => titulo.startsWith("Analisar possível desconto de EPI")),
    danoNoBanco.titulos.join(" | ").slice(0, 160));

  await page.setViewportSize({ width: 1440, height: 900 });
}

// A marca precisa aparecer como arquivo oficial, e em branco sobre fundo escuro.
await page.goto(`${base}/login`, { waitUntil: "networkidle" });
const brandSources = await page.evaluate(() => [...document.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? ""));
record("o login usa o logotipo oficial na variante clara",
  brandSources.some((src) => src.includes("vinculato-logo-light")),
  brandSources.join(" ").slice(0, 120));
await page.goto(`${base}/`, { waitUntil: "networkidle" });
const siteSources = await page.evaluate(() => [...document.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? ""));
/* A conferência dizia "colorido" e aceitava qualquer `vinculato-logo`, então
   passava com as duas variantes — inclusive com a azul-marinho sobre o
   cabeçalho escuro, onde ela some. O comentário acima já pedia branco sobre
   fundo escuro; agora a asserção cobra isso. */
record("o site usa o logotipo oficial na variante clara, legível sobre a superfície escura",
  siteSources.some((src) => src.includes("vinculato-logo-light")),
  siteSources.join(" ").slice(0, 120));

record("nenhum erro de JavaScript no console do navegador", consoleErrors.length === 0,
  [consoleErrors.slice(0, 2).join(" | "), respostasRuins.length ? `respostas: ${[...new Set(respostasRuins)].slice(0, 4).join(" | ")}` : ""]
    .filter(Boolean).join(" — "));

await browser.close();

const failures = results.filter((item) => !item.ok);
console.log(`\n${results.length - failures.length}/${results.length} verificações de navegador passaram.`);
if (failures.length) {
  console.log("Falhas:");
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
