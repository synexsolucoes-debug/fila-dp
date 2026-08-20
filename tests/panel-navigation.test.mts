import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §17 e §18: o menu por contexto e a barra superior.
 *
 * O menu tinha treze itens sob um rótulo só — "OPERAÇÃO" —, e Cadastros,
 * Relatórios e Estado das integrações não são operação. Rótulo que não descreve
 * o que está embaixo é pior que rótulo nenhum: ensina a ignorá-lo.
 *
 * Por baixo havia três listas paralelas que ninguém obrigava a concordar —
 * cabeçalho da tela, título curto para o assistente e os treze botões escritos
 * à mão — e um quarto lugar pior que os outros: a ação primária da barra
 * superior aparecia por *negação*. `view !== "registrations" && view !==
 * "auxiliary" && …` seis vezes. Uma tela nova nascia com "Nova demanda" no topo
 * sem ter demanda nenhuma para criar, e só um olho humano notaria.
 */

const source = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
const catalog = source.slice(source.indexOf("const viewCatalog: Record<View, ViewEntry>"), source.indexOf("const navOrder"));
const views = (source.match(/^type View = (.+);$/mu)?.[1] ?? "")
  .split("|").map((part) => part.trim().replace(/"/gu, "")).filter(Boolean);

test("toda tela do painel está no catálogo, com seção declarada", () => {
  assert.ok(views.length >= 13, "o tipo View não foi lido");
  for (const view of views) {
    assert.match(catalog, new RegExp(`\\n  ${view}: \\{`, "u"), `${view} fora do catálogo`);
  }
  // `Record<View, ViewEntry>` já obriga a completude no compilador; esta
  // conferência existe para o caso de o tipo afrouxar.
  const declaradas = catalog.match(/section: "(\w+)"/gu) ?? [];
  assert.equal(declaradas.length, views.length, "toda tela precisa de uma seção");
});

test("a navegação principal é organizada por processos de trabalho", () => {
  const groups = source.slice(
    source.indexOf("const processNavigationGroups"),
    source.indexOf("type ViewEntry"),
  );

  for (const label of [
    "INÍCIO",
    "DEMANDAS",
    "PROCESSOS",
    "OPERAÇÃO DP",
    "CADASTROS",
    "PONTO",
    "GESTÃO DE EPI",
    "FOLHA",
    "PAGAMENTOS",
    "DADOS E INTEGRAÇÕES",
  ]) {
    assert.match(
      groups,
      new RegExp(`label: "${label}"`, "u"),
      `grupo ${label} ausente da navegação`,
    );
  }

  assert.match(
    groups,
    /views: \["board", "inbox", "planner"\]/u,
    "Demandas deve agrupar Demandas, Inbox e Planner",
  );

  assert.match(source, /processNavigationGroups\.map/u);
  assert.match(source, /if \(!items\.length\) return null;/u);
});

test("Demandas, Inbox e Planner pertencem ao mesmo fluxo de navegação", () => {
  const groups = source.slice(
    source.indexOf("const processNavigationGroups"),
    source.indexOf("type ViewEntry"),
  );

  const demands = groups.slice(
    groups.indexOf('id: "demandas"'),
    groups.indexOf('id: "processos"'),
  );

  assert.match(demands, /"board"/u);
  assert.match(demands, /"inbox"/u);
  assert.match(demands, /"planner"/u);
});

test("registry prepara o vínculo futuro entre processo e janela sem executar processo", async () => {
  const registry = await readFile(
    new URL(
      "../app/painel/features/shared/module-window-registry.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    registry,
    /moduleKey: "demands",[\s\S]*?viewKey: "board"/u,
  );

  assert.match(
    registry,
    /moduleKey: "demands",[\s\S]*?viewKey: "inbox"/u,
  );

  assert.match(
    registry,
    /moduleKey: "demands",[\s\S]*?viewKey: "planner"/u,
  );

  assert.match(registry, /capability: "processes\.read"/u);

  assert.doesNotMatch(
    registry,
    /fetch\(|\/api\//u,
    "registry não deve chamar API nem executar módulos",
  );
});
test("a ação primária da barra é declarada, nunca deduzida por exclusão", () => {
  // Comentários fora antes de procurar: o texto que explica a decisão cita a
  // cadeia antiga, e casar com ele acusaria o contrário do que se quer.
  const codigo = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  assert.doesNotMatch(codigo, /view !== "registrations"/u,
    "a cadeia de negações é o que fazia uma tela nova nascer com o botão errado");
  assert.match(source, /\{canEdit && primaryAction && <button className="new-demand"/u);

  // Só as telas cujo objeto é a demanda oferecem o botão. As outras têm os
  // próprios comandos: um botão genérico ali criaria dois caminhos para a mesma
  // coisa, ou um caminho para coisa nenhuma.
  const comAcao = [...catalog.matchAll(/\n  (\w+): \{[\s\S]*?\n  \},/gu)]
    .filter(([bloco]) => bloco.includes("primaryAction:"))
    .map(([, nome]) => nome).sort();
  assert.deepEqual(comAcao, ["board", "inbox", "overview", "planner", "processes"]);

  // E o Inbox cria solicitação, não demanda — o rótulo acompanha a ação.
  assert.match(catalog, /primaryAction: \{ label: "Nova solicitação", kind: "inbox" \}/u);
});

test("a visibilidade é decidida num lugar só", () => {
  assert.match(source, /if \(entry\.module && !hasModule\(entry\.module\)\) return false;/u);
  assert.match(source, /return !\(role && entry\.hiddenFor\?\.includes\(role\)\);/u);
  // A comparação de papel estava escrita em sete botões. Sete cópias de uma
  // regra de acesso são sete chances de uma divergir das outras.
  const jsx = source.slice(source.indexOf('<nav aria-label="Navegação do painel">'));
  assert.doesNotMatch(jsx.slice(0, 1400), /role !== "guest"|role !== "observer"/u);
});

test("o menu mobile mantém todos os módulos alcançáveis", async () => {
  // `display: contents` devolve os botões à grade da barra. Sem isso ela
  // posicionaria os quatro grupos e mostraria quatro colunas com os itens
  // empilhados dentro — regressão que nenhum teste de unidade veria.
  const css = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  assert.match(css, /\.sidebar-nav-group \{ display: contents; \}/u);
  assert.match(css, /\.sidebar-nav-group \{ display: flex; flex-direction: column; gap: 4px; \}/u);
  assert.match(source, /const mobilePrimaryViews = new Set<View>/u);
  assert.match(source, /className="sidebar-mobile-more-panel"/u);
  assert.match(source, /aria-label="Abrir todos os módulos"/u);
  assert.match(source, /mobileNavigationRef\.current\?\.removeAttribute\("open"\)/u);
  assert.match(css, /\.dashboard-sidebar nav \.mobile-secondary \{ display: none; \}/u);
  assert.match(css, /\.sidebar-mobile-more:not\(\[open\]\) > \.sidebar-mobile-more-panel \{ display: none; \}/u,
    "o menu completo fechado não pode deixar alvos invisíveis mensuráveis");
  assert.match(css, /min-height: 48px;/u, "os destinos do menu completo precisam de alvo de toque suficiente");
});

test("o catálogo é a única fonte do título de tela", () => {
  // Havia `viewContent` e `viewTitles` em paralelo, e o assistente lia o
  // segundo: bastava atualizar um para ele passar a informar a tela errada.
  assert.doesNotMatch(source, /viewTitles|viewContent/u);
  assert.match(source, /<AssistantPanel screen=\{viewCatalog\[view\]\.label\}/u);
});

test("o botão de ajuda abre a ajuda que existe", async () => {
  // Ele respondia com uma frase fixa — "use a busca global ou abra uma demanda"
  // — que é um botão de ajuda que não ajuda: diz o que fazer sem responder à
  // pergunta. O painel do assistente já estava construído para isso, e as
  // instruções dele mandam explicar o caminho e apontar a tela e o botão.
  assert.doesNotMatch(source, /Use a busca global ou abra uma demanda/u);
  assert.match(source, /className="help-button" aria-label="Abrir o assistente"/u);
  assert.match(source, /openSignal=\{assistantSignal\}/u);

  const assistant = await readFile(new URL("../app/painel/features/assistant/AssistantPanel.tsx", import.meta.url), "utf8");
  assert.match(assistant, /if \(openSignal <= 0\) return;/u);
  // Esc continua fechando: a ajuda não pode virar parede entre a pessoa e a tela.
  assert.match(assistant, /event\.key === "Escape"/u);
});

test("o seletor de empresa da barra superior recorta a visão geral (§18, §19)", async () => {
  // Ele existia em toda tela e só o quadro o respeitava. Escolher uma empresa
  // não mexia em número nenhum da visão geral, e quem escolhia não tinha como
  // saber se aquela empresa não tinha nada ou se o filtro era enfeite.
  assert.match(source, /const scopedCards = useMemo\(/u);
  assert.match(source, /activeCards\.filter\(\(card\) => card\.companyId === companyFilter\)/u);
  // Os indicadores medem o recorte, não o grupo.
  assert.match(source, /const active = scopedCards\.filter\(\(card\) => card\.slaStatus !== "completed"\);/u);
  assert.match(source, /\}, \[scopedCards, snapshot\]\);/u);
  // E o quadro continua com os filtros dele — responsável, SLA, processo,
  // prazo —, que não valem para a visão geral.
  assert.match(source, /boardMode === "table"[\s\S]{0,80}filteredActiveCards/u);
});

test("a visão geral diz de quem são os números que mostra", () => {
  // "3 demandas em andamento" com uma empresa escolhida e "3" com o grupo
  // inteiro são o mesmo texto para fatos diferentes.
  //
  // O rótulo migrou da faixa "RESUMO OPERACIONAL" para o cabeçalho do fluxo da
  // competência, quando a faixa marinho saiu no redesenho. O requisito é o
  // mesmo: o recorte precisa estar escrito na tela, não subentendido.
  assert.match(source, /COMPETÊNCIA · \{scopeLabel\.toUpperCase\(\)\}/u);
  // E o cartão de empresas deixa de misturar um número do grupo entre três do
  // recorte.
  assert.match(source, /<span>Empresa em foco<\/span>/u);
});

test("o fluxo da competência respeita a empresa escolhida", () => {
  // O seletor de empresa já foi enfeite fora do quadro uma vez. Elemento novo
  // na visão geral entra recortado, ou repete o defeito.
  assert.match(source, /const scopedCycles = useMemo\(/u);
  assert.match(source, /companyFilter === "all" \|\| cycle\.companyId === companyFilter/u);
  assert.match(source, /<OverviewView cycles=\{scopedCycles\}/u);
});

test("as etapas do ciclo têm uma definição só", () => {
  // `cycleStages` era privado de OperationsView. Copiar a lista para a visão
  // geral criaria a segunda definição — o defeito que a §16 gastou um commit
  // inteiro para eliminar (cabeçalho 3×, selo 5×, aviso de erro 10×).
  assert.doesNotMatch(source, /status: "pre_closing", label:/u,
    "a visão geral não pode ter cópia própria das etapas");
  // A exigência é a ORIGEM, não a lista exata: fixar a linha inteira fez este
  // teste reprovar assim que o diagrama de conexões acrescentou auxiliares ao
  // mesmo import — reprovando por mudança, não por defeito.
  assert.match(source, /import \{[^}]*\bcycleStages\b[^}]*\} from "\.\/features\/shared"/u);
  assert.match(source, /import \{[^}]*\bcycleProgress\b[^}]*\} from "\.\/features\/shared"/u);
});

test("a verificação de navegador roda na CI, não só na máquina de quem lembrar", async () => {
  // Ela existia com 47 conferências contra o produto de pé e a CI só rodava a
  // de acessibilidade. É o padrão que já escondeu defeito neste repositório
  // mais de uma vez: a ferramenta certa, construída, e nunca executada.
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm run browser-check/u);
  assert.match(workflow, /npm run a11y-check/u);
  // E ela precisa das credenciais para passar do login; sem elas, reprova em
  // vez de pular em silêncio.
  assert.match(workflow, /VINCULATO_ADMIN_PASSWORD="\$FIXTURE_PASSWORD"/u);

  const check = await readFile(new URL("../scripts/browser-check.mjs", import.meta.url), "utf8");
  assert.match(check, /record\("credenciais do administrador não informadas", false/u);
  assert.match(check, /process\.exit\(1\)/u);
});

test("a semente tem uma empresa sem demanda, que é o que torna o recorte demonstrável", async () => {
  // Com uma empresa só, um seletor que recorta e um seletor que não faz nada
  // produzem exatamente a mesma tela — foi assim que o filtro ficou anos
  // aparente sem funcionar na visão geral.
  const seed = await readFile(new URL("../scripts/seed-ui-fixture.mjs", import.meta.url), "utf8");
  assert.match(seed, /'co-ui-2', 'ws-ui', 'Filial Sem Demanda LTDA'/u);
  const check = await readFile(new URL("../scripts/browser-check.mjs", import.meta.url), "utf8");
  assert.match(check, /escolher empresa recorta os indicadores da visão geral/u);
  assert.match(check, /abertasNoGrupo > 0 && abertasNaFilial === 0/u);
});

test("Relatórios e a exportação seguem o recorte de empresa (§34)", async () => {
  // O mesmo filtro ignorado da visão geral, uma tela adiante — e aqui com uma
  // consequência pior: o CSV é o único artefato do produto que sai do navegador
  // e vai para a mão de alguém. Baixado logo depois de escolher uma empresa,
  // um arquivo com o grupo inteiro sai daqui parecendo ser daquela empresa.
  assert.match(source, /<IndicatorsView canExportWorkspace=\{isAdmin\} cards=\{scopedCards\}/u);
  assert.match(source, /\.\.\.scopedCards\.map\(/u, "a exportação precisa usar o recorte");
  assert.match(source, /vinculato-demandas-\$\{sufixo\}/u, "o nome do arquivo carrega o recorte");

  // A tela consulta o servidor com o recorte e recarrega quando ele muda.
  assert.match(source, /companyId \? `&companyId=\$\{encodeURIComponent\(companyId\)\}` : ""/u);
  assert.match(source, /\}, \[reportDays, companyId\]\);/u);

  const rota = await readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8");
  // O escopo de acesso do membro é segurança e já existia; o filtro é outra
  // coisa, e faltava. Os dois convivem: o filtro nunca amplia o escopo.
  assert.match(rota, /if \(companyId\) await requireCompanyAccess\(/u);
  assert.match(rota, /if \(companyId && empresa !== companyId\) return false;/u);
  assert.match(rota, /return companyAccess\.unrestricted \|\| companyAccess\.companyIds\.has\(empresa\);/u);
});

test("a verificação de navegador prova a exportação, não só a tela", async () => {
  // Uma asserção sobre o texto da tela não teria pego o CSV: ele é montado no
  // cliente, a partir de outra lista.
  const check = await readFile(new URL("../scripts/browser-check.mjs", import.meta.url), "utf8");
  assert.match(check, /acceptDownloads: true/u);
  assert.match(check, /a exportação segue o recorte, e não o grupo/u);
  assert.match(check, /daFilial && daFilial\.length === 1/u, "o arquivo da filial vazia só pode ter cabeçalho");
});
