import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyAssigneeOptimistically, attentionRank, demandIndicators, dueBadge, filterDemands,
  defaultDemandFilters, isCriticalSla, matchesDemandSearch, operationalAlerts, parseSavedViews,
  queueSections, readBoardFilters, responsibleColumns, slaReading, sortDemands, toggleIndicator,
  writeBoardFilters, type BoardContext, type DemandFilters,
} from "../app/painel/features/board/board.model.ts";
import type { Card, WorkspaceMember, WorkspaceSnapshot } from "../lib/fila-dp-types.ts";

/**
 * O quadro da Operação DP, verificado onde ele erra em silêncio.
 *
 * Um quadro quebrado se vê: as colunas somem. O que não se vê é um indicador
 * que conta "atrasadas" com uma regra e abre um recorte com outra — a tela
 * continua bonita e o gestor distribui o dia com o número errado. Por isso o
 * que está medido aqui não é o desenho: é a conta.
 */

const AGORA = new Date("2026-09-18T10:00:00");

function demanda(patch: Partial<Card> = {}): Card {
  return {
    id: patch.id ?? crypto.randomUUID(),
    boardId: "quadro",
    listId: "analise",
    referenceNumber: 2841,
    title: "Conferência de admissão",
    description: "",
    companyId: "empresa-1",
    company: "Grupo Horizonte",
    employeeId: null,
    requesterUserId: null,
    requesterAreaId: null,
    responsibleAreaId: null,
    processType: "ADMISSAO",
    priority: "normal",
    assigneeName: "",
    dueAt: "2026-09-18T14:00:00",
    slaStatus: "safe",
    position: 1000,
    sourceType: "manual",
    archived: false,
    createdAt: "2026-09-18T08:00:00",
    updatedAt: "2026-09-18T08:00:00",
    checklist: [],
    comments: [],
    activities: [],
    assignees: [],
    labels: [],
    customValues: {},
    attachments: [],
    solidesAttachments: null,
    slaPausedReason: "",
    slaTargetMinutes: 0,
    slaPausedMinutes: 0,
    slaEscalationLevel: 0,
    competence: "",
    legalDueAt: null,
    processTemplateId: null,
    closedAt: null,
    cancelledAt: null,
    cancellationReason: "",
    nextStep: "",
    ...patch,
  };
}

function membro(name: string, patch: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    userId: `u-${name.toLowerCase().replace(/\s/gu, "-")}`,
    email: `${name.toLowerCase().replace(/\s/gu, ".")}@exemplo.com`,
    name,
    role: "member",
    joinedAt: "2026-01-01T00:00:00",
    isOwner: false,
    isActivated: true,
    companyIds: [],
    departmentId: "dp",
    departmentName: "Departamento Pessoal",
    ...patch,
  };
}

const contexto: BoardContext = {
  areaNames: new Map([["area-rh", "Recursos Humanos"], ["area-dp", "Departamento Pessoal"]]),
  waitingListIds: new Set(["aguardando"]),
  currentMemberName: "Ana Ribeiro",
};

const filtros = (patch: Partial<DemandFilters> = {}): DemandFilters => ({ ...defaultDemandFilters, ...patch });

/* ── Busca ────────────────────────────────────────────────────────────────── */

test("a busca encontra pelo que a caixa promete: protocolo, colaborador, empresa e responsável", () => {
  const card = demanda({
    referenceNumber: 2841,
    title: "Conferência de admissão",
    company: "Grupo Horizonte",
    assigneeName: "Ana Ribeiro",
    customValues: { matricula: "Mariana Costa" },
    responsibleAreaId: "area-dp",
  });
  for (const termo of ["2841", "#DM-2841", "Mariana", "Horizonte", "Ana", "Departamento Pessoal", "ADMISSAO"]) {
    assert.equal(matchesDemandSearch(card, termo, contexto), true, `não achou por "${termo}"`);
  }
  assert.equal(matchesDemandSearch(card, "Bruno", contexto), false);
});

test("quem digita sem acento encontra o que está escrito com acento", () => {
  // Uma busca que exige o acento certo responde "nada encontrado" para um termo
  // que está na tela — e quem digita com pressa não volta para corrigir.
  const card = demanda({ title: "Conferência de admissão", processType: "FÉRIAS" });
  assert.equal(matchesDemandSearch(card, "conferencia", contexto), true);
  assert.equal(matchesDemandSearch(card, "FERIAS", contexto), true);
});

test("busca vazia não esconde nada", () => {
  assert.equal(matchesDemandSearch(demanda(), "   ", contexto), true);
});

/* ── Recorte ──────────────────────────────────────────────────────────────── */

test("o recorte combina responsável, prioridade, competência e etapa sem se atrapalhar", () => {
  const cards = [
    demanda({ id: "a", assigneeName: "Ana Ribeiro", priority: "urgent", competence: "2026-09", listId: "analise" }),
    demanda({ id: "b", assigneeName: "Ana Ribeiro", priority: "normal", competence: "2026-09", listId: "analise" }),
    demanda({ id: "c", assigneeName: "", priority: "urgent", competence: "2026-08", listId: "aguardando" }),
  ];
  const so = (f: Partial<DemandFilters>) => filterDemands(cards, filtros(f), contexto, AGORA).map((card) => card.id);
  assert.deepEqual(so({ assignee: "Ana Ribeiro" }), ["a", "b"]);
  assert.deepEqual(so({ priority: "urgent" }), ["a", "c"]);
  assert.deepEqual(so({ competence: "2026-09" }), ["a", "b"]);
  assert.deepEqual(so({ listId: "aguardando" }), ["c"]);
  assert.deepEqual(so({ assignee: "Ana Ribeiro", priority: "urgent" }), ["a"]);
});

test("`sem responsável` é um recorte, e não a ausência de recorte", () => {
  /* `none` e `all` são coisas diferentes: o primeiro é a pilha por distribuir,
     o segundo é o quadro inteiro. Tratá-los como o mesmo valor foi o defeito
     que fez o indicador "sem responsável" abrir o quadro todo. */
  const cards = [demanda({ id: "sem" }), demanda({ id: "com", assigneeName: "Ana Ribeiro" })];
  assert.deepEqual(filterDemands(cards, filtros({ assignee: "none" }), contexto, AGORA).map((c) => c.id), ["sem"]);
  assert.equal(filterDemands(cards, filtros(), contexto, AGORA).length, 2);
});

/* ── Indicadores ──────────────────────────────────────────────────────────── */

test("os seis indicadores contam o que os seus rótulos dizem", () => {
  const cards = [
    demanda({ id: "1", slaStatus: "overdue", priority: "high" }),
    demanda({ id: "2", slaStatus: "warning", dueAt: "2026-09-18T18:00:00" }),
    demanda({ id: "3", slaStatus: "safe", assigneeName: "Ana Ribeiro" }),
    demanda({ id: "4", slaStatus: "completed", assigneeName: "Ana Ribeiro" }),
    demanda({ id: "5", slaStatus: "safe" }),
  ];
  const numeros = demandIndicators(cards, AGORA);
  assert.equal(numeros.open, 4, "concluída não é demanda aberta");
  assert.equal(numeros.completed, 1);
  assert.equal(numeros.overdue, 1);
  assert.equal(numeros.dueToday, 1);
  assert.equal(numeros.unassigned, 3);
  assert.equal(numeros.critical, 1, "atraso em prioridade alta é SLA crítico");
});

test("SLA crítico é regra, e não opinião: pausado e concluído nunca entram", () => {
  assert.equal(isCriticalSla(demanda({ slaStatus: "overdue", priority: "urgent" }), AGORA), true);
  assert.equal(isCriticalSla(demanda({ slaStatus: "overdue", priority: "low" }), AGORA), false);
  // Vence dentro das próximas duas horas: crítico mesmo com prioridade normal.
  assert.equal(isCriticalSla(demanda({ dueAt: "2026-09-18T11:30:00" }), AGORA), true);
  assert.equal(isCriticalSla(demanda({ dueAt: "2026-09-18T18:00:00" }), AGORA), false);
  // Pausado não está correndo, e concluído já chegou: contá-los faria o número
  // subir sozinho durante a noite.
  assert.equal(isCriticalSla(demanda({ slaStatus: "paused", dueAt: "2026-09-18T10:10:00" }), AGORA), false);
  assert.equal(isCriticalSla(demanda({ slaStatus: "completed", dueAt: "2026-09-18T10:10:00" }), AGORA), false);
});

test("clicar num indicador liga o recorte que ele conta, e clicar de novo desliga", () => {
  const ligado = toggleIndicator(filtros(), "overdue");
  assert.equal(ligado.sla, "overdue");
  assert.equal(toggleIndicator(ligado, "overdue").sla, "all");
  assert.equal(toggleIndicator(filtros(), "unassigned").assignee, "none");
  // "Abertas" é o repouso: ele desfaz, nunca liga.
  const limpo = toggleIndicator(filtros({ sla: "overdue", assignee: "none" }), "open");
  assert.equal(limpo.sla, "all");
  assert.equal(limpo.assignee, "all");
});

test("o indicador e o recorte que ele abre contam o mesmo conjunto", () => {
  /* É a regressão que este arquivo existe para impedir: o número dizia sete e
     o quadro mostrava nove porque a contagem e o filtro eram escritos em
     lugares diferentes. */
  const cards = [
    demanda({ id: "1", slaStatus: "overdue" }),
    demanda({ id: "2", slaStatus: "overdue", assigneeName: "Ana Ribeiro" }),
    demanda({ id: "3", slaStatus: "safe" }),
  ];
  const numeros = demandIndicators(cards, AGORA);
  const recorte = filterDemands(cards, toggleIndicator(filtros(), "overdue"), contexto, AGORA);
  assert.equal(recorte.length, numeros.overdue);
});

/* ── Colunas por responsável ──────────────────────────────────────────────── */

test("a coluna sem responsável vem primeiro, e só existe quando há o que distribuir", () => {
  const equipe = [membro("Ana Ribeiro"), membro("Bruno Souza")];
  const comOrfas = responsibleColumns([demanda(), demanda({ assigneeName: "Ana Ribeiro" })], equipe);
  assert.equal(comOrfas[0].key, "", "a pilha por distribuir não pode ficar no fim do quadro");
  assert.equal(comOrfas[0].name, "Sem responsável");

  const semOrfas = responsibleColumns([demanda({ assigneeName: "Ana Ribeiro" })], equipe);
  assert.equal(semOrfas.some((coluna) => coluna.key === ""), false);
});

test("quem está sem demanda também tem coluna — é o alvo do arrasto", () => {
  const colunas = responsibleColumns([demanda({ assigneeName: "Ana Ribeiro" })], [membro("Ana Ribeiro"), membro("Bruno Souza")]);
  const bruno = colunas.find((coluna) => coluna.key === "Bruno Souza");
  assert.ok(bruno, "sem coluna, não há para onde arrastar");
  assert.equal(bruno.open, 0);
});

test("observador não vira coluna: ele não pode responder por demanda", () => {
  const colunas = responsibleColumns([], [membro("Carla Mendes", { role: "observer" })]);
  assert.equal(colunas.length, 0);
});

test("a carga é relativa à pessoa mais carregada, e a ociosa não fica cheia", () => {
  const cards = [
    ...Array.from({ length: 10 }, (_, index) => demanda({ id: `b${index}`, assigneeName: "Bruno Souza" })),
    demanda({ id: "a1", assigneeName: "Ana Ribeiro" }),
  ];
  const colunas = responsibleColumns(cards, [membro("Ana Ribeiro"), membro("Bruno Souza"), membro("Carla Mendes")]);
  const carga = new Map(colunas.map((coluna) => [coluna.key, coluna.load]));
  assert.equal(carga.get("Bruno Souza"), 1);
  assert.ok((carga.get("Ana Ribeiro") ?? 0) < 0.2);
  assert.equal(carga.get("Carla Mendes"), 0);
});

test("a demanda concluída conta como entregue, e não como carga", () => {
  const colunas = responsibleColumns([
    demanda({ assigneeName: "Ana Ribeiro", slaStatus: "completed" }),
    demanda({ assigneeName: "Ana Ribeiro" }),
  ], [membro("Ana Ribeiro")]);
  assert.equal(colunas[0].open, 1);
  assert.equal(colunas[0].completed, 1);
});

/* ── Minha fila ───────────────────────────────────────────────────────────── */

test("a fila separa o que já custou prazo do que ainda dá para salvar", () => {
  const secoes = queueSections([
    demanda({ id: "atrasada", slaStatus: "overdue" }),
    demanda({ id: "hoje", dueAt: "2026-09-18T17:00:00" }),
    demanda({ id: "depois", dueAt: "2026-09-25T17:00:00" }),
    demanda({ id: "terceiros", listId: "aguardando" }),
    demanda({ id: "pronta", slaStatus: "completed" }),
  ], contexto, AGORA);
  const porSecao = new Map(secoes.map((secao) => [secao.id, secao.cards.map((card) => card.id)]));
  assert.deepEqual(porSecao.get("overdue"), ["atrasada"]);
  assert.deepEqual(porSecao.get("today"), ["hoje"]);
  assert.deepEqual(porSecao.get("next"), ["depois"]);
  assert.deepEqual(porSecao.get("waiting"), ["terceiros"]);
  assert.equal(secoes.every((secao) => !secao.cards.some((card) => card.id === "pronta")), true);
});

test("as quatro seções aparecem mesmo vazias", () => {
  // "Nada atrasado" é uma resposta que a pessoa veio buscar; esconder a seção
  // faria a ausência de atraso parecer ausência de tela.
  assert.deepEqual(queueSections([], contexto, AGORA).map((secao) => secao.id), ["overdue", "today", "next", "waiting"]);
});

/* ── Ordem ────────────────────────────────────────────────────────────────── */

test("a ordenação não altera a lista recebida e desempata por prazo", () => {
  const cards = [
    demanda({ id: "tarde", priority: "high", dueAt: "2026-09-30T10:00:00" }),
    demanda({ id: "cedo", priority: "high", dueAt: "2026-09-19T10:00:00" }),
    demanda({ id: "urgente", priority: "urgent", dueAt: "2026-10-30T10:00:00" }),
  ];
  const original = cards.map((card) => card.id);
  assert.deepEqual(sortDemands(cards, "priority").map((card) => card.id), ["urgente", "cedo", "tarde"]);
  assert.deepEqual(cards.map((card) => card.id), original, "ordenar não pode mexer na lista de quem chamou");
});

test("demanda sem prazo vai para o fim, nunca para o topo", () => {
  const cards = [demanda({ id: "sem", dueAt: null }), demanda({ id: "com", dueAt: "2026-09-19T10:00:00" })];
  assert.deepEqual(sortDemands(cards, "due").map((card) => card.id), ["com", "sem"]);
});

test("a atenção coloca o atraso antes do crítico, e o crítico antes do resto", () => {
  assert.ok(attentionRank(demanda({ slaStatus: "overdue" }), AGORA)
    < attentionRank(demanda({ dueAt: "2026-09-18T10:20:00" }), AGORA));
  assert.ok(attentionRank(demanda({ dueAt: "2026-09-18T10:20:00" }), AGORA)
    < attentionRank(demanda({ slaStatus: "safe", assigneeName: "Ana Ribeiro" }), AGORA));
});

/* ── Prazo e SLA ──────────────────────────────────────────────────────────── */

test("a etiqueta de prazo diz hoje, amanhã ou o tamanho do atraso", () => {
  assert.equal(dueBadge({ dueAt: "2026-09-18T14:00:00", slaStatus: "safe" }, AGORA), "Hoje · 14:00");
  assert.equal(dueBadge({ dueAt: "2026-09-19T09:00:00", slaStatus: "safe" }, AGORA), "Amanhã · 09:00");
  assert.equal(dueBadge({ dueAt: "2026-09-16T17:00:00", slaStatus: "overdue" }, AGORA), "2d de atraso · 17:00");
  assert.equal(dueBadge({ dueAt: null, slaStatus: "safe" }, AGORA), "Sem prazo");
  // Pausado e concluído não têm distância que interesse.
  assert.equal(dueBadge({ dueAt: "2026-09-16T17:00:00", slaStatus: "paused" }, AGORA), "Aguardando retorno");
});

test("a leitura de SLA diz a data exata, o que resta e o estado", () => {
  const leitura = slaReading(demanda({ dueAt: "2026-09-18T11:32:00" }), AGORA);
  assert.equal(leitura.deadline, "18/09/2026 11:32");
  assert.equal(leitura.remaining, "1h 32min restantes");
  assert.equal(leitura.state, "Em risco");
  assert.equal(slaReading(demanda({ dueAt: null }), AGORA).remaining, "Sem prazo definido");
});

/* ── Alertas ──────────────────────────────────────────────────────────────── */

test("os alertas saem de regras objetivas, e somem quando a contagem é zero", () => {
  // Faixa que diz "0 demandas sem responsável" treina quem lê a ignorá-la.
  assert.deepEqual(operationalAlerts([demanda({ assigneeName: "Ana Ribeiro" })], AGORA), []);

  const alertas = operationalAlerts([
    demanda({ id: "velha", createdAt: "2026-09-18T06:00:00" }),
    demanda({ id: "iminente", assigneeName: "Ana Ribeiro", dueAt: "2026-09-18T10:40:00" }),
    demanda({ id: "p1", assigneeName: "Ana Ribeiro", employeeId: "colab-1" }),
    demanda({ id: "p2", assigneeName: "Ana Ribeiro", employeeId: "colab-1" }),
    demanda({ id: "p3", assigneeName: "Ana Ribeiro", employeeId: "colab-1" }),
  ], AGORA);
  const ids = alertas.map((alerta) => alerta.id);
  assert.ok(ids.includes("unassigned-aging"));
  assert.ok(ids.includes("due-soon"));
  assert.ok(ids.includes("employee-overlap"));
  // Todo alerta que promete um recorte precisa levar a ele.
  for (const alerta of alertas) {
    if (alerta.filters) assert.ok(Object.keys(alerta.filters).length > 0);
  }
});

/* ── Endereço ─────────────────────────────────────────────────────────────── */

test("o recorte vai para a URL em português, e o valor de repouso não vai", () => {
  const escrito = writeBoardFilters(filtros({ sla: "overdue", companyId: "4" })).toString();
  assert.match(escrito, /situacao=overdue/u);
  assert.match(escrito, /empresa=4/u);
  assert.doesNotMatch(escrito, /prioridade/u, "filtro desligado não suja o endereço");
});

test("o endereço volta a ser recorte, e um endereço estranho abre o quadro em vez de quebrar", () => {
  const lido = readBoardFilters("?situacao=overdue&empresa=4&responsavel=Ana%20Ribeiro");
  assert.equal(lido.sla, "overdue");
  assert.equal(lido.companyId, "4");
  assert.equal(lido.assignee, "Ana Ribeiro");
  assert.equal(readBoardFilters("?prioridade=" + "x".repeat(400)).priority, "all");
  assert.deepEqual(readBoardFilters(""), defaultDemandFilters);
});

test("ida e volta pela URL preserva o recorte inteiro", () => {
  const original = filtros({ query: "mariana", sla: "warning", processType: "FERIAS", competence: "2026-09" });
  assert.deepEqual(readBoardFilters(writeBoardFilters(original)), original);
});

/* ── Visualizações salvas ─────────────────────────────────────────────────── */

test("recorte salvo por uma versão anterior não impede o quadro de abrir", () => {
  assert.deepEqual(parseSavedViews(null), []);
  assert.deepEqual(parseSavedViews("{não é json"), []);
  assert.deepEqual(parseSavedViews('[{"sem":"nome"}]'), []);
  const lido = parseSavedViews('[{"id":"1","name":"Admissões","mode":"inventado","filters":{"sla":"overdue"}}]');
  assert.equal(lido[0].name, "Admissões");
  assert.equal(lido[0].mode, "team", "modo desconhecido recai no quadro por responsável");
  assert.equal(lido[0].filters.sla, "overdue");
});

/* ── Atribuição otimista ──────────────────────────────────────────────────── */

test("a atribuição otimista devolve um retrato novo e não mexe no anterior", () => {
  /* O desfazer só funciona se o retrato guardado não tiver sido alterado por
     baixo — é o que devolve o cartão para a coluna de origem quando o servidor
     recusa. */
  const card = demanda({ id: "demanda-1" });
  const antes = { lists: [{ id: "analise", cards: [card] }] } as unknown as WorkspaceSnapshot;
  const depois = applyAssigneeOptimistically(antes, "demanda-1",
    { userId: "u-ana", name: "Ana Ribeiro", email: "ana@exemplo.com" });

  assert.equal(depois.lists[0].cards[0].assigneeName, "Ana Ribeiro");
  assert.equal(antes.lists[0].cards[0].assigneeName, "", "o retrato anterior foi alterado; o rollback perderia o estado");
  assert.notEqual(depois, antes);

  const devolvida = applyAssigneeOptimistically(depois, "demanda-1", null);
  assert.equal(devolvida.lists[0].cards[0].assigneeName, "");
  assert.deepEqual(devolvida.lists[0].cards[0].assignees, []);
});

/* ── Garantias que moram no código ────────────────────────────────────────── */

test("a atribuição é rota própria, com histórico e auditoria", async () => {
  const rota = await readFile(new URL("../app/api/cards/[id]/assignee/route.ts", import.meta.url), "utf8");
  /* Quem passou para quem, e quando. Sem estas três linhas o arrasto vira uma
     mudança sem autor — e "quem me passou isso?" é a pergunta que a operação
     faz quando a demanda atrasa. */
  assert.match(rota, /recordActivity\([\s\S]*?"card\.assigned"/u);
  assert.match(rota, /prepareAuditEvent/u);
  assert.match(rota, /requireCardCompanyAccess/u);
  assert.match(rota, /requireCapability\(workspace, "cards\.write"\)/u);
  assert.match(rota, /requireWorkspaceRole\(workspace\.role, \["admin", "member"\]\)/u);
});

test("a ação em massa confere o acesso de cada demanda, e não só da lista", async () => {
  const rota = await readFile(new URL("../app/api/cards/bulk/route.ts", import.meta.url), "utf8");
  // Uma lista de ids não é autorização: o recorte de empresa é por pessoa.
  assert.match(rota, /for \(const id of cardIds\) await requireCardCompanyAccess/u);
  assert.match(rota, /TOO_MANY_CARDS/u);
  assert.match(rota, /requireCapability\(workspace, "cards\.write"\)/u);
});

test("o quadro abre por responsável, e a gaveta continua sendo a gaveta", async () => {
  const painel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(painel, /useState<BoardMode>\("team"\)/u,
    "o quadro precisa abrir na pergunta que o DP faz de manhã: quem está com o quê");
  // A demanda continua abrindo ao lado do quadro, e não por cima dele.
  assert.match(painel, /demand-detail-modal demand-drawer/u);
});

test("o quadro não escreve cor à mão: a identidade vem dos tokens", async () => {
  const css = await readFile(new URL("../app/painel/features/board/board.module.css", import.meta.url), "utf8");
  const semComentario = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const cruas = semComentario.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? [];
  assert.deepEqual(cruas, [],
    "cor escrita à mão no quadro. Use um token de app/dashboard-modern.css");
  // O tema escuro não precisa de um bloco próprio: os tokens já mudam com ele.
  assert.doesNotMatch(semComentario, /theme-dark/u);
});
