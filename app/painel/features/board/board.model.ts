/**
 * O quadro de demandas como cálculo, separado do desenho.
 *
 * Tudo o que decide *o que aparece* — recorte, indicador, agrupamento por
 * responsável, carga da equipe, alerta, ordem e estado na URL — mora aqui, em
 * funções sem React e sem DOM. A razão é a de sempre neste repositório: essas
 * regras são as que erram em silêncio. Um indicador que conta "atrasadas"
 * diferente do recorte que ele abre não quebra a tela; ele só faz o gestor
 * distribuir o dia com o número errado, e ninguém descobre.
 *
 * Com o cálculo fora do componente, cada uma dessas regras pode ser verificada
 * sem navegador, com demandas construídas à mão — inclusive os casos que a tela
 * quase nunca produz e que são justamente os que quebram: quadro vazio, todo
 * mundo sem responsável, prazo ausente, competência em branco.
 */

import type { Card, CardAssignee, WorkspaceMember, WorkspaceSnapshot } from "../../../../lib/fila-dp-types.ts";

/* ── Vocabulário ──────────────────────────────────────────────────────────── */

/**
 * Como o quadro é olhado. A demanda é uma só no banco; isto é só o eixo.
 *
 * `team` é o modo principal da Operação DP — colunas por responsável — porque
 * a pergunta que abre o dia do DP não é "em que etapa está", é "quem está com
 * isso e quem está sobrando". Os demais eixos continuam existindo porque cada
 * um responde uma pergunta diferente, e nenhum deles responde essa.
 */
export const boardViewModes = ["team", "queue", "kanban", "process", "table", "calendar"] as const;
export type BoardViewMode = typeof boardViewModes[number];

export type DemandSort = "position" | "due" | "priority" | "recent" | "oldest";

/**
 * O recorte do quadro, inteiro, em um objeto.
 *
 * Estava espalhado em sete `useState` no componente do painel, e é por isso que
 * "limpar filtros" precisava lembrar de cada um deles. Junto, o recorte pode ser
 * comparado, salvo, escrito na URL e restaurado — que é o que as visualizações
 * salvas e o link compartilhado exigem.
 *
 * `all` é o valor de repouso de todo campo de escolha; `""` é o de todo campo
 * de texto. Não se usa `null` em nenhum: um filtro desligado e um filtro
 * ausente são a mesma coisa para quem lê o quadro, e distingui-los no tipo só
 * criaria dois caminhos para o mesmo estado.
 */
export type DemandFilters = {
  query: string;
  companyId: string;
  processType: string;
  /** Situação: o identificador da coluna (etapa) do quadro. */
  listId: string;
  /** Nome do responsável, `all`, ou `none` para a fila sem dono. */
  assignee: string;
  priority: string;
  due: string;
  sla: string;
  competence: string;
};

export const defaultDemandFilters: DemandFilters = {
  query: "", companyId: "all", processType: "all", listId: "all",
  assignee: "all", priority: "all", due: "all", sla: "all", competence: "",
};

/** Contexto que o recorte não carrega: nomes de área e quem está olhando. */
export type BoardContext = {
  /** Nome da área por id — o departamento é pesquisável pelo nome, não pelo id. */
  areaNames: ReadonlyMap<string, string>;
  /** Colunas com comportamento de SLA pausado: é o "aguardando terceiros". */
  waitingListIds: ReadonlySet<string>;
  /** Quem está usando o painel, para "minha fila". */
  currentMemberName: string;
};

export const emptyBoardContext: BoardContext = {
  areaNames: new Map(), waitingListIds: new Set(), currentMemberName: "",
};

/* ── Texto ────────────────────────────────────────────────────────────────── */

/**
 * Sem acento e em caixa baixa.
 *
 * Quem digita "admissao" com pressa procura "Admissão", e uma busca que exige o
 * acento certo responde "nada encontrado" para um termo que está na tela.
 */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return "";
  return value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
}

/** `#DM-2471`, ou vazio em demanda de banco anterior à migration 0070. */
export function demandReference(card: Pick<Card, "referenceNumber">): string {
  return card.referenceNumber == null ? "" : `#DM-${card.referenceNumber}`;
}

/** Quem responde hoje pela demanda; vazio é a fila sem dono, não um erro. */
export function responsibleName(card: Card): string {
  return card.assignees[0]?.name || card.assigneeName || "";
}

/**
 * Onde a busca procura.
 *
 * A caixa promete "demanda, colaborador, empresa ou protocolo", e uma busca que
 * promete quatro coisas e procura em duas é pior do que uma que promete uma.
 * O protocolo entra nas duas formas — com e sem o `#DM-` — porque quem cola o
 * número de um e-mail cola só o número.
 */
export function demandSearchHaystack(card: Card, context: BoardContext): string[] {
  const areas = [card.requesterAreaId, card.responsibleAreaId]
    .map((id) => (id ? context.areaNames.get(id) ?? "" : ""));
  return [
    demandReference(card),
    card.referenceNumber == null ? "" : String(card.referenceNumber),
    card.title,
    card.description,
    card.company,
    card.processType,
    responsibleName(card),
    card.assignees.map((assignee) => assignee.name).join(" "),
    card.customValues.matricula ?? "",
    card.nextStep,
    card.competence,
    ...areas,
  ];
}

export function matchesDemandSearch(card: Card, term: string, context: BoardContext): boolean {
  const alvo = normalizeText(term).trim();
  if (!alvo) return true;
  return demandSearchHaystack(card, context).some((value) => normalizeText(value).includes(alvo));
}

/* ── Recorte ──────────────────────────────────────────────────────────────── */

const DAY = 86_400_000;

/** Meia-noite do dia de `now`, no fuso de quem está olhando. */
export function startOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * O prazo como número, com o meio-dia das datas puras.
 *
 * `new Date("2026-09-18")` é meia-noite **UTC** — que no fuso de Brasília é
 * 21h do dia 17. Uma demanda com prazo só de data caía um dia para trás, e o
 * efeito aparecia justamente onde dói: ela sumia de "vence hoje" e entrava em
 * "atrasada" sem ter atrasado. Prazo com hora (`...T14:00`) não tem esse
 * problema e é lido como está.
 *
 * O meio-dia é a convenção que o resto do produto já usa para datas puras, e
 * esta função passou a segui-la depois que o mesmo defeito foi corrigido no
 * painel de demandas pela #138 — a regra é a mesma, e ter duas leituras de
 * data no mesmo quadro seria a próxima divergência a aparecer.
 */
const SO_DATA = /^\d{4}-\d{2}-\d{2}$/u;

export function dueTime(card: Pick<Card, "dueAt">): number {
  if (!card.dueAt) return Number.POSITIVE_INFINITY;
  const at = new Date(SO_DATA.test(card.dueAt) ? `${card.dueAt}T12:00:00` : card.dueAt).getTime();
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

export function filterDemands(
  cards: readonly Card[],
  filters: DemandFilters,
  context: BoardContext = emptyBoardContext,
  now = new Date(),
): Card[] {
  const hoje = startOfDay(now);
  const amanha = hoje + DAY;
  const semana = hoje + 7 * DAY;
  return cards.filter((card) => {
    const prazo = dueTime(card);
    const prazoCombina = filters.due === "all"
      || (filters.due === "today" && prazo >= hoje && prazo < amanha)
      || (filters.due === "week" && prazo >= hoje && prazo < semana)
      || (filters.due === "overdue" && card.slaStatus === "overdue");
    const dono = responsibleName(card);
    const donoCombina = filters.assignee === "all"
      || (filters.assignee === "none" ? dono === "" : dono === filters.assignee
        || card.assignees.some((assignee) => assignee.name === filters.assignee));
    return donoCombina
      && (filters.sla === "all" || card.slaStatus === filters.sla)
      && (filters.companyId === "all" || card.companyId === filters.companyId)
      && (filters.processType === "all" || card.processType === filters.processType)
      && (filters.listId === "all" || card.listId === filters.listId)
      && (filters.priority === "all" || card.priority === filters.priority)
      && (filters.competence === "" || card.competence === filters.competence)
      && prazoCombina
      && matchesDemandSearch(card, filters.query, context);
  });
}

/** Quantos recortes estão ligados — o número ao lado de "Filtros". */
export function activeFilterCount(filters: DemandFilters): number {
  let total = 0;
  for (const key of ["companyId", "processType", "listId", "assignee", "priority", "due", "sla"] as const) {
    if (filters[key] !== "all") total += 1;
  }
  if (filters.competence !== "") total += 1;
  if (filters.query.trim() !== "") total += 1;
  return total;
}

/* ── Indicadores ──────────────────────────────────────────────────────────── */

export type IndicatorId = "open" | "unassigned" | "dueToday" | "overdue" | "completed" | "critical";

export type DemandIndicators = Record<IndicatorId, number>;

/**
 * Quando o SLA é crítico.
 *
 * Não é um sexto status nem um cálculo novo de prazo: é a leitura de duas
 * situações que já estão nos dados e que custam caro se passarem batido —
 * atraso em demanda de prioridade alta, e prazo que vence dentro das próximas
 * duas horas. Demanda concluída ou com SLA pausado nunca entra: a primeira já
 * chegou, a segunda não está correndo, e contá-las faria o número subir sozinho
 * durante a noite.
 *
 * Duas horas, e não uma: é o tempo em que ainda dá para reorganizar o próprio
 * dia por causa daquela demanda. Uma hora já é o alerta de vencimento iminente,
 * que existe separado logo abaixo e responde outra pergunta — "largue o que
 * está fazendo", contra "não deixe isto para a tarde".
 */
export const CRITICAL_WINDOW_MINUTES = 120;

export function isCriticalSla(card: Card, now = new Date()): boolean {
  if (card.slaStatus === "completed" || card.slaStatus === "paused") return false;
  if (card.slaStatus === "overdue" && (card.priority === "urgent" || card.priority === "high")) return true;
  const prazo = dueTime(card);
  if (!Number.isFinite(prazo)) return false;
  const restante = prazo - now.getTime();
  return restante >= 0 && restante <= CRITICAL_WINDOW_MINUTES * 60_000;
}

export function demandIndicators(cards: readonly Card[], now = new Date()): DemandIndicators {
  const abertas = cards.filter((card) => card.slaStatus !== "completed");
  return {
    open: abertas.length,
    unassigned: abertas.filter((card) => responsibleName(card) === "").length,
    dueToday: abertas.filter((card) => card.slaStatus === "warning").length,
    overdue: abertas.filter((card) => card.slaStatus === "overdue").length,
    completed: cards.filter((card) => card.slaStatus === "completed").length,
    critical: abertas.filter((card) => isCriticalSla(card, now)).length,
  };
}

/**
 * O recorte que cada indicador abre.
 *
 * Um indicador que informa e não leva a lugar nenhum obriga quem lê a
 * reconstruir o filtro na mão — e a reconstrução quase nunca bate com a conta.
 * Aqui o número e o recorte saem da mesma definição: clicar em "atrasadas"
 * mostra exatamente as que foram contadas.
 *
 * `critical` não tem recorte próprio porque não existe filtro de "crítico" no
 * vocabulário do quadro; ele abre o atraso, que é a maior parte do que ele
 * conta, e o cartão marcado continua distinguível no quadro.
 */
export const indicatorFilters: Record<IndicatorId, Partial<DemandFilters>> = {
  open: { sla: "all", assignee: "all", due: "all" },
  unassigned: { assignee: "none" },
  dueToday: { sla: "warning" },
  overdue: { sla: "overdue" },
  completed: { sla: "completed" },
  critical: { sla: "overdue" },
};

/** Aplica (ou desfaz) o recorte de um indicador — clicar de novo desliga. */
export function toggleIndicator(filters: DemandFilters, indicator: IndicatorId): DemandFilters {
  const alvo = indicatorFilters[indicator];
  const ligado = (Object.entries(alvo) as Array<[keyof DemandFilters, string]>)
    .every(([key, value]) => filters[key] === value);
  if (indicator === "open") return { ...filters, sla: "all", assignee: "all", due: "all" };
  if (ligado) {
    const desfeito = { ...filters };
    for (const key of Object.keys(alvo) as Array<keyof DemandFilters>) {
      desfeito[key] = defaultDemandFilters[key];
    }
    return desfeito;
  }
  return { ...filters, ...alvo };
}

/* ── Quadro por responsável ───────────────────────────────────────────────── */

export type ResponsibleColumn = {
  /** `""` na coluna sem responsável — é a ausência do critério, não um nome. */
  key: string;
  name: string;
  /** Departamento principal da pessoa; vazio quando ela não tem um. */
  role: string;
  userId: string;
  cards: Card[];
  open: number;
  completed: number;
  overdue: number;
  dueToday: number;
  /** Carga relativa à pessoa mais carregada do quadro, de 0 a 1. */
  load: number;
};

/**
 * As colunas do quadro operacional, uma por pessoa.
 *
 * Três decisões que mudam o que o gestor enxerga:
 *
 *  1. **A coluna sem responsável existe sempre que houver o que distribuir**, e
 *     vem primeiro. Ela é a pilha que o dia começa esvaziando; no fim da lista
 *     ela seria descoberta depois de rolar o quadro inteiro.
 *  2. **Quem está sem demanda também aparece.** Uma equipe onde só quem tem
 *     trabalho tem coluna esconde exatamente a informação que resolve
 *     sobrecarga — e, no arrasto, esconde o alvo para onde a demanda deveria ir.
 *  3. **A carga é relativa, não absoluta.** Não existe "capacidade máxima" de um
 *     analista de DP registrada em lugar nenhum, e inventar um teto (dez? vinte?)
 *     seria um número falso com aparência de regra. A barra compara com a pessoa
 *     mais carregada do próprio quadro, que é uma comparação que se sustenta.
 */
export function responsibleColumns(
  cards: readonly Card[],
  members: readonly WorkspaceMember[],
  options: { includeIdle?: boolean } = {},
): ResponsibleColumn[] {
  const porNome = new Map<string, Card[]>();
  for (const card of cards) {
    const nome = responsibleName(card);
    const atual = porNome.get(nome);
    if (atual) atual.push(card); else porNome.set(nome, [card]);
  }

  /* Só admin e membro respondem por demanda: observador e convidado não podem
     ser alvo de atribuição, e uma coluna para eles seria um alvo de arrasto que
     o servidor recusaria. */
  const operacionais = members.filter((member) => member.role === "admin" || member.role === "member");
  if (options.includeIdle !== false) {
    for (const member of operacionais) if (!porNome.has(member.name)) porNome.set(member.name, []);
  }

  const perfil = new Map(operacionais.map((member) => [member.name, member]));
  const colunas: ResponsibleColumn[] = [...porNome.entries()].map(([nome, lista]) => {
    const abertas = lista.filter((card) => card.slaStatus !== "completed");
    return {
      key: nome,
      name: nome || "Sem responsável",
      role: perfil.get(nome)?.departmentName ?? "",
      userId: perfil.get(nome)?.userId ?? "",
      cards: lista,
      open: abertas.length,
      completed: lista.length - abertas.length,
      overdue: abertas.filter((card) => card.slaStatus === "overdue").length,
      dueToday: abertas.filter((card) => card.slaStatus === "warning").length,
      load: 0,
    };
  });

  const maior = colunas.reduce((total, coluna) => (coluna.key ? Math.max(total, coluna.open) : total), 0);
  for (const coluna of colunas) coluna.load = maior > 0 ? Math.min(1, coluna.open / maior) : 0;

  return colunas.sort((left, right) => {
    // A pilha por distribuir primeiro; depois quem tem mais em aberto.
    if ((left.key === "") !== (right.key === "")) return left.key === "" ? -1 : 1;
    if (left.open !== right.open) return right.open - left.open;
    return left.name.localeCompare(right.name, "pt-BR");
  }).filter((coluna) => coluna.key !== "" || coluna.cards.length > 0);
}

/** Como a barra de carga é lida: só a cor não pode ser a informação (§39). */
export function loadTone(load: number): "calm" | "busy" | "heavy" {
  if (load >= 0.8) return "heavy";
  if (load >= 0.5) return "busy";
  return "calm";
}

export const loadLabel: Record<ReturnType<typeof loadTone>, string> = {
  calm: "carga leve", busy: "carga média", heavy: "carga alta",
};

/* ── Minha fila ───────────────────────────────────────────────────────────── */

export type QueueSectionId = "overdue" | "today" | "next" | "waiting";

export type QueueSection = { id: QueueSectionId; label: string; hint: string; cards: Card[] };

/**
 * A fila de uma pessoa, na ordem em que o dia acontece.
 *
 * Não é um filtro por responsável com outro nome: a diferença é a separação
 * entre o que já custou prazo, o que ainda dá para salvar hoje, o que vem
 * depois e o que não depende de você. Sem essa separação, "minhas 23 demandas"
 * é uma lista, e uma lista não diz por onde começar.
 *
 * "Aguardando terceiros" vem das colunas com SLA pausado — é o que o quadro já
 * sabia e não dizia em lugar nenhum.
 */
export function queueSections(cards: readonly Card[], context: BoardContext, now = new Date()): QueueSection[] {
  const hoje = startOfDay(now);
  const amanha = hoje + DAY;
  const aguardando: Card[] = [];
  const atrasadas: Card[] = [];
  const doDia: Card[] = [];
  const proximas: Card[] = [];

  for (const card of cards) {
    if (card.slaStatus === "completed") continue;
    if (card.slaStatus === "paused" || context.waitingListIds.has(card.listId)) { aguardando.push(card); continue; }
    if (card.slaStatus === "overdue") { atrasadas.push(card); continue; }
    const prazo = dueTime(card);
    if (prazo >= hoje && prazo < amanha) doDia.push(card); else proximas.push(card);
  }

  const porPrazo = (lista: Card[]) => lista.sort((left, right) => dueTime(left) - dueTime(right));
  return [
    { id: "overdue", label: "Atrasadas", hint: "Já passaram do prazo interno.", cards: porPrazo(atrasadas) },
    { id: "today", label: "Hoje", hint: "Vencem antes do fim do expediente.", cards: porPrazo(doDia) },
    { id: "next", label: "Próximas", hint: "Prazo à frente; dá para planejar.", cards: porPrazo(proximas) },
    { id: "waiting", label: "Aguardando terceiros", hint: "O SLA está pausado esperando retorno.", cards: porPrazo(aguardando) },
  ];
}

/* ── Ordem ────────────────────────────────────────────────────────────────── */

const priorityRank: Record<Card["priority"], number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const createdTime = (card: Card) => {
  const at = new Date(card.createdAt).getTime();
  return Number.isNaN(at) ? 0 : at;
};

/**
 * Ordena sem alterar a lista recebida.
 *
 * O desempate é sempre o prazo. Duas demandas da mesma prioridade não têm ordem
 * definida entre si, e sem critério estável elas trocam de lugar a cada
 * atualização do snapshot — o cartão que a pessoa ia clicar sai de baixo do
 * cursor.
 */
export function sortDemands(cards: readonly Card[], sort: DemandSort): Card[] {
  if (sort === "position") return [...cards];
  const copia = [...cards];
  if (sort === "priority") copia.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || dueTime(a) - dueTime(b));
  else if (sort === "recent") copia.sort((a, b) => createdTime(b) - createdTime(a) || dueTime(a) - dueTime(b));
  else if (sort === "oldest") copia.sort((a, b) => createdTime(a) - createdTime(b) || dueTime(a) - dueTime(b));
  else copia.sort((a, b) => dueTime(a) - dueTime(b));
  return copia;
}

/**
 * Quanto uma demanda pede atenção, do mais para o menos.
 *
 * Serve para destacar, e não para reordenar por conta própria: a ordem do
 * quadro continua sendo a que a pessoa escolheu. Um quadro que se reorganiza
 * sozinho tira do gestor a única coisa que ele controla ali.
 */
export function attentionRank(card: Card, now = new Date()): number {
  if (card.slaStatus === "overdue") return 0;
  if (isCriticalSla(card, now)) return 1;
  if (card.slaStatus === "warning") return 2;
  if (responsibleName(card) === "") return 3;
  if (card.checklist.some((item) => !item.completed)) return 4;
  return 5;
}

/* ── Alertas ──────────────────────────────────────────────────────────────── */

export type BoardAlert = { id: string; tone: "danger" | "warn" | "info"; text: string; filters?: Partial<DemandFilters> };

const UNASSIGNED_GRACE_MINUTES = 120;
const SIMULTANEOUS_PROCESSES = 3;

/**
 * O que precisa de atenção agora, por regra objetiva.
 *
 * Nenhuma inferência e nenhuma previsão: são três contagens sobre o que já está
 * no quadro, cada uma correspondendo a um erro operacional concreto — pedido
 * parado sem dono, prazo prestes a estourar, e a mesma pessoa em processos
 * simultâneos (admissão e desligamento do mesmo colaborador ao mesmo tempo é o
 * caso que mais gera retrabalho no DP).
 *
 * Alerta sem contagem não aparece. Uma faixa que diz "0 demandas sem
 * responsável" treina quem lê a ignorá-la, e no dia em que houver três ela já
 * terá virado moldura.
 */
export function operationalAlerts(cards: readonly Card[], now = new Date()): BoardAlert[] {
  const alertas: BoardAlert[] = [];
  const abertas = cards.filter((card) => card.slaStatus !== "completed");

  const paradas = abertas.filter((card) => {
    if (responsibleName(card) !== "") return false;
    const desde = new Date(card.createdAt).getTime();
    return !Number.isNaN(desde) && now.getTime() - desde > UNASSIGNED_GRACE_MINUTES * 60_000;
  }).length;
  if (paradas > 0) {
    alertas.push({
      id: "unassigned-aging", tone: "warn", filters: { assignee: "none" },
      text: `${paradas} ${paradas === 1 ? "demanda está" : "demandas estão"} sem responsável há mais de 2 horas`,
    });
  }

  const iminentes = abertas.filter((card) => {
    const restante = dueTime(card) - now.getTime();
    return Number.isFinite(restante) && restante >= 0 && restante <= 60 * 60_000;
  }).length;
  if (iminentes > 0) {
    alertas.push({
      id: "due-soon", tone: "danger", filters: { due: "today" },
      text: `${iminentes} ${iminentes === 1 ? "demanda vence" : "demandas vencem"} nos próximos 60 minutos`,
    });
  }

  const porColaborador = new Map<string, number>();
  for (const card of abertas) {
    if (!card.employeeId) continue;
    porColaborador.set(card.employeeId, (porColaborador.get(card.employeeId) ?? 0) + 1);
  }
  const acumulados = [...porColaborador.values()].filter((total) => total >= SIMULTANEOUS_PROCESSES).length;
  if (acumulados > 0) {
    alertas.push({
      id: "employee-overlap", tone: "info",
      text: `${acumulados} ${acumulados === 1 ? "colaborador tem" : "colaboradores têm"} ${SIMULTANEOUS_PROCESSES} ou mais processos simultâneos`,
    });
  }

  return alertas;
}

/* ── Prazo e SLA ──────────────────────────────────────────────────────────── */

export type SlaReading = { deadline: string; remaining: string; state: string };

const pad = (value: number) => String(value).padStart(2, "0");

export function formatDeadline(value: string | null): string {
  if (!value) return "Sem prazo definido";
  const prazo = new Date(value.includes("T") ? value : `${value}T12:00:00`);
  if (Number.isNaN(prazo.getTime())) return "Sem prazo definido";
  return `${pad(prazo.getDate())}/${pad(prazo.getMonth() + 1)}/${prazo.getFullYear()} ${pad(prazo.getHours())}:${pad(prazo.getMinutes())}`;
}

/** `Hoje · 14:00`, `2d de atraso · 17:00`, `21/09 · 09:00`. */
export function dueBadge(card: Pick<Card, "dueAt" | "slaStatus">, now = new Date()): string {
  if (card.slaStatus === "paused") return "Aguardando retorno";
  if (card.slaStatus === "completed") return "Concluída";
  if (!card.dueAt) return "Sem prazo";
  const prazo = new Date(card.dueAt.includes("T") ? card.dueAt : `${card.dueAt}T12:00:00`);
  if (Number.isNaN(prazo.getTime())) return "Sem prazo";
  const hora = `${pad(prazo.getHours())}:${pad(prazo.getMinutes())}`;
  const dias = Math.round((startOfDay(prazo) - startOfDay(now)) / DAY);
  if (dias === 0) return `Hoje · ${hora}`;
  if (dias === 1) return `Amanhã · ${hora}`;
  if (dias < 0) return `${Math.abs(dias)}d de atraso · ${hora}`;
  if (dias <= 30) return `Em ${dias}d · ${hora}`;
  return `${pad(prazo.getDate())}/${pad(prazo.getMonth() + 1)} · ${hora}`;
}

/**
 * O que a etiqueta de prazo diz quando alguém para o cursor sobre ela.
 *
 * A etiqueta é curta porque o cartão é compacto; a consequência é que ela
 * esconde a data exata e o quanto ainda resta. As duas aparecem aqui, e com a
 * leitura de SLA junto — "em risco" é a informação que faz alguém mudar a
 * ordem do próprio dia, e ela não cabia no cartão.
 */
export function slaReading(card: Card, now = new Date()): SlaReading {
  const restanteMs = dueTime(card) - now.getTime();
  const finito = Number.isFinite(restanteMs);
  const minutos = finito ? Math.round(Math.abs(restanteMs) / 60_000) : 0;
  const horas = Math.floor(minutos / 60);
  const dias = Math.floor(horas / 24);
  const duracao = !finito ? "—"
    : dias >= 1 ? `${dias}d ${horas % 24}h`
    : horas >= 1 ? `${horas}h ${minutos % 60}min`
    : `${minutos}min`;

  const state = card.slaStatus === "completed" ? "Concluído"
    : card.slaStatus === "paused" ? "Pausado, aguardando retorno"
    : card.slaStatus === "overdue" ? "Estourado"
    : isCriticalSla(card, now) ? "Em risco"
    : card.slaStatus === "warning" ? "Vence hoje"
    : "Dentro do prazo";

  return {
    deadline: formatDeadline(card.dueAt),
    remaining: !finito ? "Sem prazo definido"
      : restanteMs < 0 ? `${duracao} de atraso`
      : `${duracao} restantes`,
    state,
  };
}

/* ── Estado na URL ────────────────────────────────────────────────────────── */

/**
 * Chaves curtas e em português na URL.
 *
 * O endereço do quadro é colado no chat da equipe dezenas de vezes por dia
 * ("olha essas atrasadas da Horizonte"), e quem cola lê o que está colando.
 * `?situacao=atrasada&empresa=4` diz o que abre; `?f=eyJzbGEiOi...` não.
 *
 * `empresa` já era lido pelo endereço do painel e continua sendo o mesmo
 * parâmetro — duas grafias para o mesmo recorte é o começo de duas fontes de
 * verdade.
 */
const FILTER_KEYS: Array<[keyof DemandFilters, string]> = [
  ["query", "busca"],
  ["companyId", "empresa"],
  ["processType", "processo"],
  ["listId", "etapa"],
  ["assignee", "responsavel"],
  ["priority", "prioridade"],
  ["due", "prazo"],
  ["sla", "situacao"],
  ["competence", "competencia"],
];

export function writeBoardFilters(filters: DemandFilters, into = new URLSearchParams()): URLSearchParams {
  for (const [key, parameter] of FILTER_KEYS) {
    const value = filters[key];
    if (value && value !== defaultDemandFilters[key]) into.set(parameter, value);
    else into.delete(parameter);
  }
  return into;
}

export function readBoardFilters(search: string | URLSearchParams): DemandFilters {
  const parameters = typeof search === "string"
    ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
    : search;
  const filters = { ...defaultDemandFilters };
  for (const [key, parameter] of FILTER_KEYS) {
    const value = parameters.get(parameter);
    /* Valor longo demais não é filtro, é alguém testando o endereço. Cortar em
       vez de recusar: um link estranho abre o quadro, não uma tela de erro. */
    if (typeof value === "string" && value.length <= 160) filters[key] = value;
  }
  return filters;
}

/* ── Visualizações salvas ─────────────────────────────────────────────────── */

export type SavedBoardView = { id: string; name: string; mode: BoardViewMode; filters: DemandFilters };

export const SAVED_VIEWS_LIMIT = 12;

/** Presets que todo grupo de DP usa, sem ninguém precisar montá-los. */
export function presetViews(currentMemberName: string): Array<{ id: string; label: string; filters: Partial<DemandFilters>; mode?: BoardViewMode }> {
  return [
    { id: "minha-fila", label: "Minha fila", mode: "queue", filters: { assignee: currentMemberName || "all" } },
    { id: "sem-responsavel", label: "Sem responsável", filters: { assignee: "none" } },
    { id: "atrasadas", label: "Atrasadas", filters: { sla: "overdue" } },
    { id: "hoje", label: "Hoje", filters: { due: "today" } },
    { id: "semana", label: "Esta semana", filters: { due: "week" } },
  ];
}

/**
 * Lê as visualizações salvas de um texto que veio do armazenamento local.
 *
 * Tolerante de propósito: o que está gravado no navegador de alguém pode ter
 * sido escrito por uma versão anterior do produto, e uma visualização salva
 * malformada não pode impedir o quadro de abrir. O que não for reconhecido é
 * descartado em silêncio — é uma conveniência, não um dado do cliente.
 */
export function parseSavedViews(raw: string | null): SavedBoardView[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 40) : "";
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!name || !id) return [];
      const mode = boardViewModes.includes(entry.mode as BoardViewMode) ? entry.mode as BoardViewMode : "team";
      const filters = { ...defaultDemandFilters };
      if (entry.filters && typeof entry.filters === "object") {
        for (const [key] of FILTER_KEYS) {
          const value = (entry.filters as Record<string, unknown>)[key];
          if (typeof value === "string" && value.length <= 160) filters[key] = value;
        }
      }
      return [{ id, name, mode, filters }];
    }).slice(0, SAVED_VIEWS_LIMIT);
  } catch {
    return [];
  }
}


/* ── Atribuição otimista ──────────────────────────────────────────────────── */

/**
 * O quadro com a demanda já na coluna de destino, antes de o servidor responder.
 *
 * Arrastar um cartão e vê-lo voltar para a coluna de origem por meio segundo é
 * o defeito que faz alguém arrastar de novo — e a segunda atribuição é a que
 * gera a linha duplicada no histórico. A tela vai na frente; se o servidor
 * recusar, quem chamou devolve o retrato anterior inteiro, e o cartão volta
 * para onde estava com o motivo escrito na faixa de erro.
 *
 * Devolve um retrato novo, sem tocar no recebido: guardar o anterior para o
 * desfazer só funciona se ele não tiver sido alterado por baixo.
 */
export function applyAssigneeOptimistically(
  snapshot: WorkspaceSnapshot,
  cardId: string,
  assignee: CardAssignee | null,
): WorkspaceSnapshot {
  return {
    ...snapshot,
    lists: snapshot.lists.map((list) => ({
      ...list,
      cards: list.cards.map((card) => (card.id === cardId
        ? { ...card, assignees: assignee ? [assignee] : [], assigneeName: assignee?.name ?? "" }
        : card)),
    })),
  };
}
