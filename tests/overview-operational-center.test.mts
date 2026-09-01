import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  overviewPeriodDays,
  overviewPeriodLabel,
  overviewPeriods,
  periodWindowEnd,
  periodWindowStart,
  withinPeriod,
} from "../lib/overview-period.ts";

/**
 * §12–§19: a Visão geral como central operacional.
 *
 * O quadro responde "o que está aberto". Estes blocos respondem três perguntas
 * que ele não responde: como o processo está andando (§15), o que vence sem
 * esperar ninguém (§16) e o que aconteceu agora há pouco (§19) — tudo sob os
 * dois recortes do topo, empresa e período (§13).
 */

const painel = new URL("../app/painel/WorkspaceApp.tsx", import.meta.url);
const dados = new URL("../lib/fila-dp-db.ts", import.meta.url);
const tipos = new URL("../lib/fila-dp-types.ts", import.meta.url);
const source = await readFile(painel, "utf8");
const dbSource = await readFile(dados, "utf8");
const typesSource = await readFile(tipos, "utf8");

/** Recorta um trecho do painel entre duas marcas, para a conferência mirar o
 *  bloco em questão e não o arquivo inteiro — detector largo demais reprova
 *  código correto, que é o defeito mais repetido desta auditoria. */
function bloco(inicio: string, fim: string) {
  const de = source.indexOf(inicio);
  assert.notEqual(de, -1, `não achei "${inicio}" no painel`);
  const ate = source.indexOf(fim, de);
  assert.notEqual(ate, -1, `não achei o fim "${fim}" a partir de "${inicio}"`);
  return source.slice(de, ate + fim.length);
}

/* ── §13: o recorte de período ─────────────────────────────────────────── */

test("sem período escolhido nada é escondido", () => {
  assert.equal(periodWindowEnd("all"), null);
  assert.equal(periodWindowStart("all"), null);
  // E o `null` da janela deixa passar qualquer prazo, inclusive o ausente.
  assert.equal(withinPeriod("2030-01-01T12:00:00Z", null), true);
  assert.equal(withinPeriod(null, null), true);
});

test("a demanda sem prazo nunca é filtrada por uma janela de datas", () => {
  // Sumir com ela transformaria o filtro em esconderijo de trabalho real: o
  // contador diria menos do que existe, e ninguém saberia por quê.
  const fim = periodWindowEnd("today", new Date("2026-05-10T09:00:00"));
  assert.notEqual(fim, null);
  assert.equal(withinPeriod(null, fim), true);
  assert.equal(withinPeriod(undefined, fim), true);
  assert.equal(withinPeriod("", fim), true);
});

test("o atrasado entra em qualquer janela", () => {
  // O que venceu antes do intervalo é justamente o que mais precisa de atenção
  // hoje. A janela tem teto, não piso.
  const agora = new Date("2026-05-10T09:00:00");
  const fim = periodWindowEnd("week", agora);
  assert.equal(withinPeriod("2026-04-01T12:00:00Z", fim), true, "vencido há mais de um mês");
  assert.equal(withinPeriod("2026-05-09T12:00:00Z", fim), true, "vencido ontem");
});

test("a janela é ancorada na meia-noite de hoje, não no relógio", () => {
  // Com âncora móvel, "próximos 7 dias" às 9h e às 17h do mesmo dia devolveriam
  // conjuntos diferentes, e o indicador mudaria sozinho durante o expediente.
  const manha = periodWindowEnd("week", new Date("2026-05-10T09:00:00"));
  const tarde = periodWindowEnd("week", new Date("2026-05-10T17:45:00"));
  assert.equal(manha, tarde);
});

test("cada janela tem o tamanho que o rótulo promete", () => {
  const agora = new Date("2026-05-10T09:00:00");
  const meiaNoite = new Date(2026, 4, 10).getTime();
  const dia = 24 * 60 * 60 * 1000;
  assert.equal(periodWindowEnd("today", agora), meiaNoite + dia);
  assert.equal(periodWindowEnd("week", agora), meiaNoite + 7 * dia);
  assert.equal(periodWindowEnd("month", agora), meiaNoite + 30 * dia);
});

test("o prazo fora da janela fica de fora, e o de dentro entra", () => {
  const agora = new Date("2026-05-10T09:00:00");
  const fim = periodWindowEnd("week", agora);
  assert.equal(withinPeriod("2026-05-14T12:00:00Z", fim), true, "dentro dos 7 dias");
  assert.equal(withinPeriod("2026-06-20T12:00:00Z", fim), false, "além dos 7 dias");
});

test("data ilegível não esconde a demanda", () => {
  // O defeito está no dado. Escondê-lo do operador é o pior dos dois
  // resultados possíveis: ele perde a demanda e não fica sabendo do defeito.
  const fim = periodWindowEnd("today", new Date("2026-05-10T09:00:00"));
  assert.equal(withinPeriod("não é uma data", fim), true);
});

test("a janela retrospectiva das movimentações olha para trás", () => {
  const agora = new Date("2026-05-10T09:00:00");
  const piso = periodWindowStart("week", agora);
  assert.equal(piso, agora.getTime() - 7 * 24 * 60 * 60 * 1000);
});

test("todo período tem rótulo, e nenhum rótulo se repete", () => {
  // Dois recortes com o mesmo nome no seletor seriam indistinguíveis para quem
  // escolhe — e o filtro pareceria não funcionar em um deles.
  const rotulos = overviewPeriods.map((item) => item.label);
  assert.equal(new Set(rotulos).size, rotulos.length);
  for (const item of overviewPeriods) {
    assert.equal(overviewPeriodLabel(item.key), item.label);
    assert.equal(overviewPeriodDays(item.key), item.days);
  }
  // `all` é o padrão e precisa ser o primeiro: uma central operacional que abre
  // já escondendo coisa mente sobre o tamanho da operação.
  assert.equal(overviewPeriods[0]?.key, "all");
  assert.equal(overviewPeriodDays("all"), 0);
});

test("o período recorta todos os blocos da Visão geral, não só um", () => {
  // O seletor de empresa já foi enfeite fora do quadro uma vez (§18, §19).
  // Filtro novo entra alcançando tudo, ou repete o defeito.
  assert.match(source, /const scopedCards = useMemo\([\s\S]{0,240}inPeriod\(card\.dueAt\)/u);
  assert.match(source, /const scopedLists = useMemo\([\s\S]{0,280}inPeriod\(card\.dueAt\)/u);
  assert.match(source, /const scopedFlows = useMemo\([\s\S]{0,240}inPeriod\(flow\.dueAt\)/u);
  assert.match(source, /const scopedObligations = useMemo\([\s\S]{0,280}withinPeriod\(/u);
  assert.match(source, /const scopedActivities = useMemo\(/u);
});

test("o seletor de período só aparece onde ele manda", () => {
  // Exibi-lo no quadro sugeriria um recorte que o quadro não aplica, e filtro
  // que não filtra é pior que filtro nenhum.
  assert.match(source, /view === "overview" && <label className="header-period-select"/u);
  assert.match(source, /aria-label="Selecionar período"/u);
});

/* ── §14: a faixa de indicadores ───────────────────────────────────────── */

test("o indicador que tem onde ser resolvido é botão, não texto", () => {
  // Ler "3 integrações com erro" e não ter caminho para elas é o indicador
  // cobrando uma ação que ele mesmo não deixa tomar.
  //
  // A faixa mudou de forma três vezes: sete cartões soltos, depois os três
  // contextos do §7.2, agora os cinco indicadores da maquete. A exigência é a
  // mesma nas três: quem carrega o rótulo é quem carrega o `onFocus`, e o
  // elemento é botão de verdade — teclado, foco e leitor de tela dependem do
  // elemento, não do cursor.
  const faixa = bloco('key: "demands-open"', " ];");
  for (const rotulo of ["Demandas em aberto", "Fluxos em andamento", "Obrigações próximas", "Integrações com erro", "SLA no prazo"]) {
    assert.ok(faixa.includes(`label: "${rotulo}"`), `"${rotulo}" sumiu da faixa de indicadores`);
  }
  // Todo indicador declara um destino: nenhum fica mudo.
  const destinos = [...faixa.matchAll(/target: "(\w+)"/gu)].map((match) => match[1]);
  assert.equal(destinos.length, 5, `${destinos.length} indicador(es) com destino — a faixa da maquete tem cinco`);
  assert.equal(new Set(destinos).size >= 4, true, "quatro dos cinco indicadores caem no mesmo lugar");
  // E o elemento é botão, não uma `div` com `onClick`.
  assert.match(source, /<button type="button" key=\{kpi\.key\} data-metric=\{kpi\.key\}/u);
  assert.match(source, /className=\{`overview-kpi\$\{kpi\.alert \? " requires-attention" : ""\}`\}\s*\n?\s*onClick=\{\(\) => onFocus\(kpi\.target, kpi\.sla\)\}/u);
  assert.doesNotMatch(source, /<div[^>]*overview-kpi[^>]*onClick/u,
    "indicador clicável precisa ser <button>, senão teclado e leitor de tela não alcançam");
});

test("o indicador de demandas em aberto mantém a âncora que o ensaio de navegador mira", async () => {
  // Este teste existe por um defeito real: os indicadores viraram botão e o
  // ensaio de navegador mirava `.overview-metrics article strong` com
  // `.first()`. O seletor passou a casar com "Documentos pendentes" — 0 tanto
  // no grupo quanto numa filial vazia —, e a conferência do recorte por empresa
  // comparou 0 com 0 e reprovou a CI. A âncora tira o ensaio da dependência do
  // tipo de elemento e da ordem dos cartões, e é ela que permitiu reorganizar a
  // faixa duas vezes desde então sem tocar no ensaio.
  assert.match(source, /key: "demands-open"/u);
  // O valor precisa continuar dentro de um `strong`, que é o que o ensaio lê.
  assert.match(source, /<strong className="overview-kpi-value">\{kpi\.value\}<\/strong>/u);
  const ensaio = await readFile(new URL("../scripts/browser-check.mjs", import.meta.url), "utf8");
  assert.match(ensaio, /\[data-metric="demands-open"\] strong/u);
  // E o seletor frágil não pode voltar.
  assert.doesNotMatch(ensaio, /locator\("\.overview-metrics/u);
  assert.doesNotMatch(ensaio, /waitForSelector\("\.overview-metrics/u);
});

test("chegar pelo indicador zera os outros filtros do quadro", () => {
  // Chegar de um número e encontrar uma lista menor que ele, porque um filtro
  // antigo continuava ligado, faz o indicador parecer errado.
  assert.match(
    source,
    /onFocus=\{\(target, sla\) => \{[\s\S]{0,400}setAssigneeFilter\("all"\); setProcessFilter\("all"\); setDueFilter\("all"\);[\s\S]{0,80}setSlaFilter\(sla\)/u,
  );
});

test("o indicador de SLA leva ao quadro já recortado no atraso", () => {
  // A garantia é a de sempre, através de três formatos de faixa: quem lê um
  // número de prazo chega ao quadro já recortado no atraso, e não numa lista
  // inteira onde precisa refazer o filtro à mão.
  const sla = bloco('key: "sla-on-time"', '},\n  ];');
  assert.match(sla, /target: "board", sla: "overdue"/u);
  // E os dois números que faziam alguém agir continuam escritos na faixa.
  assert.match(sla, /\$\{atrasadas\} atrasada\(s\)/u);
  assert.match(sla, /\$\{venceHoje\} vencendo hoje/u);
});

/* ── §15: fluxos em andamento ──────────────────────────────────────────── */

test("o fluxo só considera demanda com versão instanciada e ainda em execução", () => {
  // Demanda sem `process_version_id` nunca foi instanciada a partir de um
  // processo: ela é trabalho avulso, e listá-la como "fluxo" seria inventar um
  // processo que ninguém publicou.
  assert.match(dbSource, /AND c\.process_version_id IS NOT NULL AND c\.process_version_id <> ''/u);
  assert.match(dbSource, /AND c\.sla_status <> 'completed'/u);
});

test("o fluxo carrega a versão que a demanda instanciou, não a vigente", () => {
  // §29: alteração no processo não pode reescrever demanda antiga. O número
  // exibido vem da coluna gravada na criação.
  assert.match(dbSource, /c\.process_version_number/u);
  assert.match(source, /\{flow\.versionNumber && <em className="overview-version-tag"\s*\n?\s*title=\{`Versão instanciada nesta demanda: \$\{flow\.versionNumber\}`\}/u);
});

test("o progresso é contado no banco, não trazendo as tarefas", () => {
  // A Visão geral mostra "7 de 18", não a lista. Trazer dezoito itens por
  // demanda para exibir dois números é payload que ninguém abre.
  assert.match(dbSource, /\(SELECT count\(\*\)::int FROM fdp_checklist_items ci WHERE ci\.card_id = c\.id\) AS tasks_total/u);
  assert.match(dbSource, /AND ci\.completed = 1\) AS tasks_done/u);
});

test("processo sem tarefa instanciada não vira 100% concluído", () => {
  // Uma demanda "pronta" que ninguém executou é pior que uma sem progresso.
  assert.match(dbSource, /progress: tasksTotal > 0 \? Math\.round\(\(tasksDone \/ tasksTotal\) \* 100\) : 0/u);
});

test("o rótulo da etapa tem ordem de precedência declarada", () => {
  // Configuração primeiro, desenho depois, identificador cru por último. Cair
  // no identificador é o pior caso e ainda assim diz onde a demanda parou.
  assert.match(dbSource, /stepLabel: configured \|\| \(graph && stepId \? stepLabel\(graph, stepId\) : stepId\)/u);
});

test("o diagrama é buscado por versão em execução, não por demanda", () => {
  // Sessenta demandas do mesmo processo repetiriam o mesmo XML sessenta vezes.
  assert.match(dbSource, /SELECT DISTINCT c\.process_version_id FROM fdp_cards c/u);
});

/* ── §16: próximos vencimentos ─────────────────────────────────────────── */

test("a obrigação concluída não é vencimento próximo", () => {
  assert.match(dbSource, /WHERE o\.workspace_id = \? AND o\.status <> 'completed'/u);
});

test("o atraso da obrigação é dito como atraso, não como número negativo", () => {
  // "Vence em -2 dias" é o tipo de frase que só um sistema escreve.
  assert.match(source, /\$\{Math\.abs\(item\.daysRemaining\)\} dia\(s\) em atraso/u);
  assert.match(source, /item\.daysRemaining === 0 \? "Vence hoje"/u);
});

test("o prazo legal conta dia corrido, não dia útil", () => {
  // O vencimento de uma obrigação cai no dia que cai, feriado ou não. Dia útil
  // é a régua do SLA da demanda, que é outra coisa.
  assert.match(dbSource, /daysRemaining: Math\.round\([\s\S]{0,160}86_400_000/u);
});

/* ── §75: o recorte de acesso vale para os blocos novos ────────────────── */

test("bloco novo não vira caminho lateral para ver o que o recorte esconde", () => {
  // O filtro de empresa autorizada é aplicado às demandas desde sempre. Uma
  // consulta nova que o ignorasse mostraria, por outro ângulo, exatamente o que
  // `isVisibleCompany` existe para negar.
  assert.match(dbSource, /const processFlows = \([\s\S]{0,400}\.filter\(\(row\) => isVisibleCompany\(row\.company_id\)\)/u);
  assert.match(dbSource, /const upcomingObligations = \([\s\S]{0,200}\.filter\(\(row\) => isVisibleCompany\(row\.company_id\)\)/u);
});

test("as duas consultas novas são escopadas por workspace", () => {
  // Multi-tenancy (§75): nenhuma delas pode existir sem `workspace_id = ?`.
  assert.match(
    dbSource,
    /FROM fdp_cards c[\s\S]{0,900}JOIN fdp_process_definitions[\s\S]{0,900}WHERE c\.workspace_id = \?/u,
  );

  assert.match(
    dbSource,
    /FROM fdp_compliance_obligations o[\s\S]{0,400}WHERE o\.workspace_id = \?/u,
  );
});

test("o contrato dos dois blocos está declarado no tipo do snapshot", () => {
  assert.match(typesSource, /processFlows: ProcessFlowSummary\[\];/u);
  assert.match(typesSource, /upcomingObligations: UpcomingObligation\[\];/u);
});

/* ── A tela como central de operação (§93) e o cartão (§38, §95) ────────── */

test("a Visão geral é a central de operação da maquete, e nada além dela (§93)", async () => {
  /* Medido antes de mexer, com 15 demandas reais no banco: a página tinha
     2738px e o indicador "Demandas em aberto" ficava em y=1610 — quase duas
     telas abaixo do topo. A §93 pede "central de operação" e proíbe "dashboard
     genérico de cards", e a primeira correção foi de ordem: os indicadores
     subiram para o topo.

     A maquete foi além da ordem. Ela não tem competência, central de ação,
     prévia do quadro, atalhos nem cartões de módulo — os dois últimos repetem,
     dentro da página, a navegação que já está na barra lateral, que é o
     "dashboard genérico" que a §93 nomeia. A tela passa a ter quatro blocos, e
     este teste guarda os dois lados: os que entram e os que não voltam. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  const layout = app.slice(app.indexOf('<div className="overview-layout">'),
    app.indexOf("function MemberCompanyAccess"));

  const posicao = (marca: string) => layout.indexOf(marca);
  const metricas = posicao('className="overview-kpis"');
  assert.ok(metricas > 0, "a faixa de indicadores sumiu da Visão geral");

  // Os quatro blocos da maquete, na ordem dela.
  for (const [marca, nome] of [
    ["flows-panel", "fluxos em andamento"],
    ["obligations-panel", "próximos vencimentos"],
    ["status-panel", "demandas por status"],
    ["<ConnectionMap", "saúde das integrações"],
    ["activity-panel", "últimas movimentações"],
  ] as const) {
    assert.ok(posicao(marca) > metricas, `${nome} precisa vir depois dos indicadores`);
  }
  // Fluxos e vencimentos lado a lado; status e integrações lado a lado.
  assert.ok(posicao("flows-panel") < posicao("obligations-panel"));
  assert.ok(posicao("status-panel") < posicao("<ConnectionMap"));
  // E o histórico fecha a tela: é consulta, não operação.
  assert.ok(posicao("activity-panel") > posicao("<ConnectionMap"));

  /* Os seis que saíram. Cada um continua alcançável em outro lugar — a
     competência em Operação DP, a central de ação em "Meu trabalho", os
     atalhos na barra lateral, o quadro e os módulos no próprio menu —, e é
     por isso que sair daqui não os perde. */
  for (const [marca, onde] of [
    ["<CompetenceFlow", "Operação DP"],
    ["<ActionCenter", "Meu trabalho"],
    ['className="overview-panel board-preview"', "o próprio quadro"],
    ['className="workspace-shortcuts"', "a barra lateral"],
    ['className="workspace-processes"', "o menu"],
    ["attention-panel", "o indicador de SLA, que leva ao quadro filtrado"],
  ] as const) {
    assert.equal(posicao(marca), -1,
      `${marca} voltou à Visão geral; a maquete o tirou daqui e ele vive em ${onde}`);
  }
});

test("o cartão da demanda mostra a etapa do processo (§38, §95)", async () => {
  /* A §95 pede que "progressos, SLA, etapa e responsável" fiquem claros no
     quadro. Das quatro, a etapa era a única ausente — apesar de a §38 separar
     status de etapa exatamente porque são coisas diferentes: a coluna diz onde
     a demanda está no quadro, a etapa diz onde ela está no processo. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /className="dashboard-card-step"/u);
  assert.match(app, /flowByCard\.get\(card\.id\)/u);
  assert.match(app, /\{flow\.stepLabel\}/u,
    "a etapa precisa continuar sendo texto no cartão, não só um title");
});

test("a etapa do cartão não custa consulta nova", async () => {
  // `processFlows` já resolve o rótulo no servidor, com o mesmo recorte de
  // empresa. Uma consulta por cartão seria dezenas de idas ao banco para
  // repetir o que o snapshot já traz.
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  const memo = app.slice(app.indexOf("const flowByCard"), app.indexOf("const scopedObligations"));
  assert.match(memo, /snapshot\?\.processFlows/u);
  assert.ok(!/fetch\(|requestJson/u.test(memo), "o cartão passou a buscar a etapa por conta própria");
});

test("demanda fora do teto de fluxos não ganha etapa inventada", async () => {
  // A consulta traz 60 demandas em andamento. Passando disso, o cartão mostra
  // ausência — que é verdade — em vez de um rótulo aproximado.
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /\{flowByCard\.get\(card\.id\) && </u,
    "sem a guarda, demanda sem fluxo carregado renderizaria etapa vazia");
});

test("a mesma obrigação em várias empresas ocupa uma linha, com a contagem", async () => {
  /* A consulta devolve uma linha por empresa. Doze filiais com o mesmo eSocial
     S-1299 ocupavam as seis vagas do painel com o mesmo prazo repetido, e a
     sétima obrigação — de outro tipo, talvez mais urgente — não aparecia. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /function groupObligations\(/u);
  assert.match(app, /item\.companies > 1\s*\n?\s*\? `\$\{item\.companies\} empresas`/u);
  assert.match(app, /groupObligations\(obligations\)\.slice\(0, 6\)/u,
    "o painel precisa listar o agrupado, não a lista crua");
});

test("obrigações com vencimentos diferentes não são fundidas", async () => {
  /* Mesma obrigação com prazos diferentes são dois compromissos. Juntá-los
     esconderia o mais apertado atrás do mais folgado. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /const chave = `\$\{item\.title\}\|\$\{item\.competence\}\|\$\{item\.dueDate\}`/u);
  assert.match(app, /if \(item\.daysRemaining < atual\.daysRemaining\) atual\.daysRemaining = item\.daysRemaining/u,
    "o grupo precisa manter o prazo mais apertado, senão a urgência some na agregação");
});

test("o botão do histórico entrou junto com a tela, e aponta para ela", async () => {
  /* Este teste nasceu ao contrário: enquanto não havia tela de histórico, ele
     cobrava que o botão NÃO existisse — link que leva ao lugar errado é pior
     que nenhum. A tela existe agora, então ele cobra a outra metade: que o
     botão exista e aponte para uma visão registrada. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  const painel = app.slice(app.indexOf('className="overview-panel activity-panel"'));
  const bloco = painel.slice(0, painel.indexOf("</section>"));
  assert.match(bloco, /onFocus\("history", "all"\)/u,
    "o bloco de movimentações precisa dar caminho para a trilha completa");
  assert.match(bloco, /Ver histórico completo/u);

  const rotas = await readFile(new URL("../lib/panel-routes.ts", import.meta.url), "utf8");
  assert.match(rotas, /history: "historico"/u,
    "o destino precisa ser uma visão com endereço próprio, senão o botão leva a lugar nenhum");
});

test("sem demanda no recorte, o painel não afirma 100% dentro do prazo", async () => {
  /* O cálculo caía em `: 100` quando não havia nenhuma demanda. O número mais
     tranquilizador da tela aparecia justamente quando não havia evidência para
     tranquilizar ninguém — percentual sobre denominador zero. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /onTime: scopedCards\.length\s*\n?\s*\? Math\.round/u);
  assert.match(app, /: null,/u);
  assert.ok(!/\) \* 100\) : 100,/u.test(app),
    "voltar a 100 no recorte vazio traria de volta a afirmação sobre nada");
  assert.match(app, /stats\.onTime === null \? "—"/u,
    "o cartão precisa mostrar ausência, não zero nem cem");
});

test("a faixa de SLA diz qual população o percentual mede", async () => {
  /* "100% dentro do prazo" ao lado de "0 demandas concluídas" fazia supor que
     100% das concluídas cumpriram o prazo. O percentual mede as demandas EM
     ABERTO que não estouraram; são populações diferentes. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /das demandas em aberto/u);
  assert.match(app, /\{typeof kpi\.bar === "number" && <span className="overview-kpi-bar"/u,
    "barra de progresso sem número para representar não deve ser desenhada");
});

test("a faixa de indicadores não deixa célula vazia na dobra mais nobre", async () => {
  /* O defeito original: sete indicadores com `minmax(172px)` davam cinco
     colunas em 1440px — 5 + 2, com três células mortas ao lado dos dois
     últimos. Com cinco indicadores o arranjo só fecha se os cinco couberem
     lado a lado na largura útil; senão volta o mesmo resto de divisão, agora
     como 4 + 1.
     O outro lado é o inverso: mínimo fixo demais mantém cinco colunas numa tela
     onde elas não cabem, e o conteúdo espreme ou transborda. Por isso a
     conferência é sobre `auto-fit` — que reduz o número de colunas sozinho — e
     sobre o mínimo caber cinco vezes em 1440px, que é a resolução alvo. */
  const css = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  const faixa = css.match(/\.overview-kpis \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\((\d+)px, 1fr\)\); gap: (\d+)px;/u);
  assert.ok(faixa, "a faixa de indicadores deixou de ser uma grade que se adapta sozinha");
  const minimo = Number(faixa[1]);
  const intervalo = Number(faixa[2]);
  // 1440 menos a barra lateral e os recuos da coluna de conteúdo.
  const colunaUtil = 1440 - 268 - 92;
  assert.ok(minimo * 5 + intervalo * 4 <= colunaUtil,
    `cinco indicadores de ${minimo}px não cabem nos ${colunaUtil}px úteis de 1440px`);
  // E em tablet os cinco não podem insistir em ficar lado a lado.
  assert.ok(minimo * 5 + intervalo * 4 > 768 - 40,
    "o mínimo é pequeno demais: cinco colunas continuariam espremidas no tablet");
});
/* -------------------------------------------------------------------------- */
/* Os cinco indicadores da faixa                                               */
/* -------------------------------------------------------------------------- */

test("a faixa tem os cinco indicadores da maquete, e nenhum a mais", async () => {
  /* A faixa já foi sete cartões soltos e já foi três contextos agrupados. A
     maquete pede cinco, e cinco é o número que cabe lado a lado na dobra sem
     virar uma parede de caixas iguais — que é o defeito que a §7.2 nomeia. */
  const faixa = bloco('key: "demands-open"', " ];");
  const chaves = [...faixa.matchAll(/key: "([a-z-]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(chaves, ["demands-open", "flows-running", "obligations-due", "integrations-failing", "sla-on-time"]);
  // Todo indicador tem ícone: o rótulo sozinho força ler os cinco para achar um.
  assert.equal((faixa.match(/icon: [A-Z]/gu) ?? []).length, 5, "há indicador sem ícone");
});

test("nenhum número da faixa é fixo no código", async () => {
  /* §13: estado vazio é preferível a dado falso. Cada valor da faixa precisa
     sair de uma expressão — das demandas, dos fluxos, das obrigações ou das
     integrações que o snapshot traz. Um literal aqui seria um KPI inventado,
     que é exatamente o que a especificação proíbe.

     Inclui a frase de apoio: a maquete desenha uma variação percentual ao lado
     do número ("+12% vs. mês anterior"), e o snapshot não carrega série
     histórica nenhuma. Escrever aquele "+12%" seria inventar a medição. */
  const faixa = bloco('key: "demands-open"', " ];");
  const fixos = [...faixa.matchAll(/value: "([^"$]*\d[^"]*)"/gu)].map((match) => match[1]);
  assert.deepEqual(fixos, [], `número fixo na faixa: ${fixos.join(", ")}`);
  const apoiosFixos = [...faixa.matchAll(/support: "([^"$]*\d[^"]*)"/gu)].map((match) => match[1]);
  assert.deepEqual(apoiosFixos, [], `frase de apoio com número fixo: ${apoiosFixos.join(", ")}`);
  assert.doesNotMatch(faixa, /vs\.? (o )?(mês|período) anterior/iu,
    "a variação da maquete só pode entrar quando houver série histórica para medi-la");
  // E os valores vêm mesmo das fontes reais, não de um objeto montado à parte.
  for (const fonte of ["stats.active", "flows.length", "obligations.length", "integrationsFailing", "stats.onTime", "stats.documentsPending", "stats.completed", "stats.waiting"]) {
    assert.ok(faixa.includes(fonte), `a faixa deixou de ler ${fonte}`);
  }
});

test("o alerta do indicador também sai de um número, e não de uma decisão escrita", async () => {
  /* Um `alert: true` fixo pintaria de âmbar um cartão que está em ordem. Cada
     alerta precisa ser a comparação de um valor medido. */
  const faixa = bloco('key: "demands-open"', " ];");
  const alertas = [...faixa.matchAll(/alert: ([^,\n]+)/gu)].map((match) => match[1].trim());
  assert.equal(alertas.length, 5);
  for (const alerta of alertas) {
    assert.ok(alerta === "false" || /[a-zA-Z]/u.test(alerta.replace(/true|false/u, "")),
      `alerta fixo em "true": ${alerta}`);
  }
  assert.ok(alertas.includes("obrigacoesVencidas > 0"));
  assert.ok(alertas.includes("integrationsFailing > 0"));
});

test("sem demanda no recorte a faixa não afirma 100% dentro do prazo", async () => {
  /* O cálculo caía em `: 100` quando não havia nenhuma demanda. O número mais
     tranquilizador da tela aparecia justamente quando não havia evidência para
     tranquilizar ninguém — percentual sobre denominador zero. */
  const sla = bloco('key: "sla-on-time"', "},\n  ];");
  assert.match(sla, /stats\.onTime === null \? "—"/u,
    "o indicador precisa mostrar ausência, não zero nem cem");
  assert.match(sla, /"Sem demandas em aberto neste recorte"/u);
  // Barra sem número para representar não deve ser desenhada.
  assert.match(source, /\{typeof kpi\.bar === "number" && <span className="overview-kpi-bar"/u);
});

test("sem sincronização registrada a faixa diz isso, em vez de inventar uma data", async () => {
  /* Um traço parece dado que faltou carregar; uma data qualquer seria mentira.
     "Nunca" é a informação verdadeira quando nenhuma integração sincronizou. */
  assert.match(source, /\$\{ultimaSincronizacao \?\? "Nunca"\}/u);
  assert.match(source, /const marcas = integrations\.map\(\(item\) => item\.lastSyncAt\)/u,
    "a última sincronização precisa sair do campo real das integrações");
});

test("o recorte vigente fica escrito junto dos números", async () => {
  /* Cinco números sem dizer sobre qual conjunto foram medidos são cinco números
     sobre nada — e a Visão geral tem dois filtros no topo que mudam os cinco de
     uma vez. O rótulo do recorte é o que impede a leitura errada. */
  assert.match(source, /aria-label=\{`Indicadores da operação — \$\{scopeLabel\}`\}/u);
});

test("processos em execução conta processos distintos, não demandas", async () => {
  /* Doze admissões correndo são UM processo com doze demandas. Contá-las como
     doze processos diria que a operação roda doze fluxos diferentes — e é a
     confusão entre modelo e execução que o §4 existe para separar. */
  assert.match(source, /const processosEmExecucao = new Set\(flows\.map\(\(flow\) => flow\.definitionId\)\)\.size/u);
  // E o indicador diz qual dos dois números é qual: fluxos correndo no valor,
  // processos distintos na frase de apoio.
  const fluxos = bloco('key: "flows-running"', "},");
  assert.match(fluxos, /value: String\(flows\.length\)/u);
  assert.match(fluxos, /plural\(processosEmExecucao, "processo distinto", "processos distintos"\)/u);
});

test("a faixa não recalcula o que é 'vence hoje' por conta própria", async () => {
  /* Este teste nasce de um defeito que a tela mostrou de pé: o resumo dizia
     "Vencendo hoje: 0" logo acima de um painel com três demandas etiquetadas
     "Vence hoje". A primeira versão comparava `dueAt` com a data do navegador;
     o resto do produto pergunta ao `slaStatus`, que conhece expediente e
     feriado. Dois cálculos para a mesma pergunta sempre acabam discordando —
     e quem lê não tem como saber qual dos dois números acreditar. */
  assert.match(source, /const venceHoje = cards\.filter\(\(card\) => card\.slaStatus === "warning"\)\.length/u);
  const inicio = source.indexOf('className="overview-kpis"');
  const antes = source.slice(0, inicio);
  assert.doesNotMatch(antes.slice(antes.lastIndexOf("const integrationsFailing")),
    /getFullYear\(\)|getMonth\(\)|getDate\(\)/u,
    "a faixa voltou a decidir o que vence hoje pelo calendário do navegador");
  // E o rótulo é o mesmo que o cartão usa para o mesmo estado.
  assert.match(source, /if \(status === "warning"\) return "Vence hoje";/u);
});

/* -------------------------------------------------------------------------- */
/* As tabelas da Visão geral (maquete)                                         */
/* -------------------------------------------------------------------------- */

test("as tabelas têm cabeçalho de coluna de verdade", () => {
  /* `<td>` em negrito parece cabeçalho e não é: o leitor de tela não associa a
     célula à sua coluna, e quem navega por teclado perde a referência ao rolar.
     `<th scope="col">` é o que faz a associação existir. */
  for (const [tabela, colunas] of [
    ["overview-flow-table", ["Processo", "Etapa atual", "Progresso", "Responsável", "Situação"]],
    ["overview-obligation-table", ["Obrigação", "Empresa", "Competência", "Vencimento", "Situação"]],
    ["overview-status-table", ["Demanda", "Empresa", "Responsável", "Prazo"]],
    ["overview-activity-table", ["Data e hora", "Evento", "Relacionado a", "Responsável", "Empresa"]],
  ] as const) {
    const trecho = bloco(tabela, "</table>");
    for (const coluna of colunas) {
      assert.match(trecho, new RegExp(`<th scope="col">${coluna}</th>`, "u"),
        `a coluna ${coluna} de ${tabela} sumiu ou deixou de ser <th>`);
    }
  }
});

test("a linha da tabela não vira clicável no lugar de um botão", () => {
  /* `<tr onClick>` não recebe foco, não é anunciado como destino e não responde
     ao Enter. O caminho para a demanda é um botão dentro da célula. */
  /* Sem tirar os comentários, esta própria conferência acusaria a explicação
     escrita ao lado do botão — que cita `<tr onClick>` justamente para dizer
     por que ele não está ali. */
  const tela = bloco('<div className="overview-layout">', "function MemberCompanyAccess")
    .replace(/\/\*[\s\S]*?\*\//gu, "");
  assert.doesNotMatch(tela, /<tr[^>]*onClick/u);
  assert.match(source, /className="overview-table-link" onClick=\{\(\) => onOpenCard\(flow\.cardId\)\}/u);
  assert.match(source, /className="overview-table-link" onClick=\{\(\) => onOpen\(card\)\}/u);
});

test("a situação do prazo continua escrita, e não só colorida", () => {
  /* A borda esquerda repete o estado de SLA que o quadro usa. Cor sozinha não
     carrega o dado para quem não distingue matiz — a palavra tem de estar lá,
     e com o mesmo vocabulário do cartão do quadro. */
  assert.match(source, /<span className=\{`overview-sla-tag sla-\$\{flow\.slaStatus\}`\}>\{compactSlaLabel\(flow\.slaStatus, flow\.dueAt\)\}<\/span>/u);
  assert.match(source, /<span className=\{`overview-sla-tag sla-\$\{card\.slaStatus\}`\}>\{compactSlaLabel\(card\.slaStatus, card\.dueAt\)\}<\/span>/u);
});

test("o bloco de status abre numa aba com conteúdo, não numa vazia", () => {
  /* Abrir na primeira coluna do quadro — quase sempre a de entrada, quase
     sempre vazia — faria a tela parecer sem dados justamente quando há. */
  assert.match(source, /\?\? lists\.find\(\(list\) => list\.cards\.length > 0\)/u);
  // A contagem vem no próprio rótulo: escolher a aba não pode ser às cegas.
  assert.match(source, /\{list\.name\}<b>\{list\.cards\.length\}<\/b>/u);
  // E a janela de seis avisa o total, senão a aba parece a lista inteira.
  assert.match(source, /Mostrando 6 de \{statusList\.cards\.length\}/u);
});

test("o histórico diz a que demanda o evento se refere", () => {
  /* O evento dizia "moveu a demanda de coluna" sem dizer QUAL demanda, e
     descobrir exigia abrir o histórico inteiro. A coluna nova resolve isso a
     partir do mesmo snapshot — nenhuma consulta a mais. */
  assert.match(source, /const cardById = new Map\(cards\.map\(\(card\) => \[card\.id, card\]\)\)/u);
  assert.match(source, /const demanda = activity\.cardId \? cardById\.get\(activity\.cardId\) : undefined/u);
  /* Evento cuja demanda o recorte não alcança fica sem a coluna, e não com o
     título de outra: mostrar a demanda errada é pior que mostrar nenhuma. */
  assert.match(source, /: <span className="overview-ausente">—<\/span>/u);
});

test("a última sincronização é dita em qualquer estado do conector", () => {
  /* Ela faltava justamente no conector com erro — e é ali que ela responde a
     pergunta que importa: há quanto tempo este sistema parou de trazer dado. */
  assert.match(source, /\{connectionStatusLabel\(item\.status\)\} · \{lastSyncLabel\(item\.lastSyncAt\)\}/u);
  assert.doesNotMatch(source, /item\.status === "connected" \? ` · \$\{lastSyncLabel/u);
});
