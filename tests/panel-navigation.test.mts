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

test("toda tela do painel está no catálogo", () => {
  assert.ok(views.length >= 13, "o tipo View não foi lido");
  for (const view of views) {
    assert.match(catalog, new RegExp(`\\n  ${view}: \\{`, "u"), `${view} fora do catálogo`);
  }
});

/**
 * §25 e §64: o menu deixou de agrupar por departamento e passou a agrupar por
 * processo.
 *
 * Os quatro rótulos anteriores — OPERAÇÃO, PESSOAS E CADASTROS, FINANCEIRO,
 * DADOS E ANÁLISE — respondiam "de quem é esta tela". Quem apura uma
 * competência de PJ atravessava três deles para um processo só. A estrutura
 * agora mora num módulo puro, e é lá que estes testes a cobram: o componente
 * só desenha o que ele decide.
 */
test("a estrutura por processo é decidida num módulo puro, não no componente", async () => {
  const nav = await readFile(new URL("../lib/process-navigation.ts", import.meta.url), "utf8");
  // Sem React nem ícone: um módulo puro é o que permite testar a estrutura sem
  // montar a árvore, e o que impede o menu de virar a quinta lista paralela.
  assert.doesNotMatch(nav, /from "react"|lucide-react/u);
  assert.match(source, /import \{ hasSubNavigation, visibleProcessGroups \} from "@\/lib\/process-navigation"/u);
  // O componente não pode ter uma segunda cópia da estrutura.
  assert.doesNotMatch(source, /const navSections/u, "a lista por departamento não pode voltar");
  assert.doesNotMatch(catalog, /section: "/u, "a seção por departamento saiu do catálogo");
});

test("todo processo tem nome, descrição e ao menos um módulo", async () => {
  const { processGroups } = await import("../lib/process-navigation.ts");
  assert.ok(processGroups.length >= 5, "a estrutura por processo não foi lida");
  for (const group of processGroups) {
    assert.ok(group.label.length > 2, `${group.id} sem nome`);
    // A descrição vira o subtítulo do cabeçalho contextual da §70. Um grupo
    // sem ela é pasta sem explicação.
    assert.ok(group.description.length > 30, `${group.id} precisa de uma linha do que o processo faz`);
    assert.ok(group.views.length >= 1, `${group.id} sem módulo nenhum`);
  }
});

test("toda tela pertence a exatamente um processo, e todo processo aponta para tela que existe", async () => {
  // O modo de falhar aqui é silencioso: uma tela nova fora de qualquer grupo
  // some do menu sem erro de compilação e sem tela em branco.
  const { viewsWithoutProcess, unknownProcessViews, processGroups } = await import("../lib/process-navigation.ts");
  assert.deepEqual(viewsWithoutProcess(views), [], "tela sem processo: ela não tem porta no menu");
  assert.deepEqual(unknownProcessViews(views), [], "processo apontando para tela que não existe");

  const vistas = processGroups.flatMap((group) => group.views);
  assert.equal(new Set(vistas).size, vistas.length, "uma tela em dois processos: o menu a mostraria duas vezes");
});

test("a Operação DP e os Pagamentos agrupam o que a §26 pede junto", async () => {
  const { groupOfView } = await import("../lib/process-navigation.ts");
  // O exemplo literal da §26: demandas, inbox e planner sob a operação.
  for (const view of ["board", "inbox", "planner", "processes"]) {
    assert.equal(groupOfView(view)?.id, "operacao-dp", `${view} deveria estar na Operação DP`);
  }
  // E a competência de PJ deixa de atravessar três seções.
  for (const view of ["contractorPayments", "psychologistPayments", "auxiliary", "payroll"]) {
    assert.equal(groupOfView(view)?.id, "pagamentos", `${view} deveria estar em Pagamentos`);
  }
  assert.equal(groupOfView("epi")?.id, "epi");
  // A home não mora em processo nenhum: ela é a porta para todos.
  assert.equal(groupOfView("overview"), null);
});

test("um processo sem tela alcançável não vira item de menu (§30)", async () => {
  const { visibleProcessGroups, hasSubNavigation } = await import("../lib/process-navigation.ts");
  // Papel sem acesso a EPI, plano sem os módulos de pagamento: os processos
  // somem inteiros em vez de virarem pastas vazias.
  const grupos = visibleProcessGroups(["overview", "board", "inbox"]);
  assert.deepEqual(grupos.map((group) => group.id), ["operacao-dp"]);
  assert.deepEqual(grupos[0].views, ["board", "inbox"], "o recorte precisa alcançar os módulos, não só o grupo");
  assert.deepEqual(visibleProcessGroups(["overview"]), [], "sem módulo nenhum, não há processo a mostrar");

  // Subnavegação com uma aba só é ruído: um processo recortado a um módulo
  // deixa de tê-la, mesmo que o catálogo declare quatro.
  assert.equal(hasSubNavigation({ views: ["board"] }), false);
  assert.equal(hasSubNavigation({ views: ["board", "inbox"] }), true);
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

test("o segundo nível só aparece para o processo aberto (§66)", () => {
  // A barra não pode voltar a listar cada página do sistema ao mesmo tempo.
  assert.match(source, /\{sub && open && <div className="sidebar-process-views"/u);
  // E o processo aberto continua marcado mesmo quando o destino ativo é um
  // submódulo: sem isso, entrar em "Pagamentos → Psicólogos" apagaria a marca
  // do processo e a pessoa perderia de vista em que contexto está.
  assert.match(source, /const open = activeGroup\?\.id === group\.id;/u);
  assert.match(source, /\$\{open \? "open " : ""\}/u);
  // Entrar num processo abre o primeiro módulo dele, não uma tela intermediária
  // que só repetiria a lista que o menu já mostra.
  assert.match(source, /const entrance = group\.views\[0\];/u);
});

test("o cabeçalho do processo não pisca ao trocar de aba dentro dele (§69, §70)", () => {
  // Ele fica FORA do bloco que a transição de módulo remonta. Dentro, trocar de
  // aba faria o cabeçalho do processo reanimar — e a troca de contexto, que é o
  // que a §69 quer comunicar, deixaria de se distinguir da troca de tela dentro
  // do contexto.
  const contexto = source.indexOf('<section className="process-context"');
  const transicao = source.indexOf("<PageTransition transitionKey={view}");
  assert.ok(contexto > 0 && transicao > contexto,
    "o cabeçalho do processo precisa vir antes da transição, e fora dela");
  // Abas com indicador deslizante (§17), não troca instantânea de cor.
  assert.match(source, /<AnimatedTabs\n\s+label=\{`Módulos de \$\{activeGroup\.label\}`\}/u);
  // Um processo de um módulo só não ganha cabeçalho contextual: seria um
  // título repetindo o título da tela logo abaixo.
  assert.match(source, /\{activeGroup && hasSubNavigation\(activeGroup\) && \(/u);
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
  // empilhados dentro — regressão que nenhum teste de unidade veria. O
  // invólucro do segundo nível precisa do mesmo tratamento, senão ele
  // reintroduz a coluna que o `contents` do grupo acabou de dissolver.
  const css = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  assert.match(css, /\.sidebar-nav-group, \.sidebar-process \{ display: contents; \}/u);
  assert.match(css, /\.sidebar-process-views \{ display: none; \}/u,
    "o segundo nível não cabe na barra inferior de cinco alvos");
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
