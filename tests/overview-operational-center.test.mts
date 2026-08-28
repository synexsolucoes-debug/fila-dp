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
  for (const rotulo of ["Demandas em aberto", "Fluxos em andamento", "Obrigações próximas", "Integrações com erro"]) {
    // O `onFocus` precisa ser o handler do próprio elemento que carrega o
    // rótulo — não um botão qualquer em algum lugar acima dele.
    const padrao = new RegExp(`onFocus\\([^)]*\\)\\}>\\s*<span>${rotulo}</span>`, "u");
    assert.match(source, padrao, `"${rotulo}" precisa levar a algum lugar`);
  }
  // E o elemento é botão de verdade, não uma `article` com `onClick`: teclado,
  // foco e leitor de tela dependem do elemento, não do cursor.
  assert.equal((source.match(/className=\{?["`]overview-metric-action/gu) ?? []).length, 5);
});

test("o indicador de demandas em aberto mantém a âncora que o ensaio de navegador mira", async () => {
  // Este teste existe por um defeito real: os indicadores viraram botão e o
  // ensaio de navegador mirava `.overview-metrics article strong` com
  // `.first()`. O seletor passou a casar com "Documentos pendentes" — 0 tanto
  // no grupo quanto numa filial vazia —, e a conferência do recorte por empresa
  // comparou 0 com 0 e reprovou a CI. A âncora tira o ensaio da dependência do
  // tipo de elemento e da ordem dos cartões.
  assert.match(source, /data-metric="demands-open"/u);
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
  assert.match(source, /onFocus\("board", "overdue"\)[\s\S]{0,120}<span>SLA em risco<\/span>/u);
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
  assert.match(source, /\{flow\.versionNumber && <em title=\{`Versão instanciada nesta demanda: \$\{flow\.versionNumber\}`\}/u);
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
  const fluxos = dbSource.slice(dbSource.indexOf("FROM fdp_cards c\n      JOIN fdp_process_definitions"));
  assert.match(fluxos.slice(0, 900), /WHERE c\.workspace_id = \?/u);
  assert.match(dbSource, /FROM fdp_compliance_obligations o[\s\S]{0,400}WHERE o\.workspace_id = \?/u);
});

test("o contrato dos dois blocos está declarado no tipo do snapshot", () => {
  assert.match(typesSource, /processFlows: ProcessFlowSummary\[\];/u);
  assert.match(typesSource, /upcomingObligations: UpcomingObligation\[\];/u);
});

/* ── A tela como central de operação (§93) e o cartão (§38, §95) ────────── */

test("a Visão geral abre com os números, não com o menu (§93)", async () => {
  /* Medido antes de mexer, com 15 demandas reais no banco: a página tinha
     2738px e o indicador "Demandas em aberto" ficava em y=1610 — quase duas
     telas abaixo do topo. Os 1610px anteriores eram a competência, três blocos
     quase sempre vazios e 480px de cartões que repetem o menu lateral.

     A §93 pede "central de operação" e proíbe "dashboard genérico de cards".
     A correção é de ordem: a faixa de indicadores precisa vir antes de tudo
     que é contexto ou navegação. Depois da troca, o mesmo indicador mede
     y=170. */
  const app = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  const layout = app.slice(app.indexOf('<div className="overview-layout">'),
    app.indexOf('function MemberCompanyAccess'));

  const posicao = (marca: string) => layout.indexOf(marca);
  const metricas = posicao('className="overview-metrics"');
  assert.ok(metricas > 0, "a faixa de indicadores sumiu da Visão geral");

  for (const [marca, nome] of [
    ['<CompetenceFlow', "competência"],
    ['<ActionCenter', "central de ação"],
    ['className="workspace-shortcuts"', "atalhos"],
    ['className="workspace-processes"', "cartões de módulo"],
  ] as const) {
    assert.ok(posicao(marca) > metricas,
      `${nome} voltou a ficar antes dos indicadores — a §93 pede a operação primeiro`);
  }

  // E o que exige ação vem logo depois dos números: é o que faz alguém agir.
  assert.ok(posicao('className="overview-sla-band"') > metricas);
  assert.ok(posicao('attention-panel') < posicao('<CompetenceFlow'),
    "o que exige ação precisa vir antes do contexto do mês");
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
