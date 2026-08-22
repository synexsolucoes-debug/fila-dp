/**
 * Contrato comum de trabalho e a Central de Trabalho (§3 a §12).
 *
 * A auditoria contou pelo menos quatro objetos que significam "alguém precisa
 * fazer alguma coisa": demandas (`fdp_cards`), movimentações
 * (`fdp_employee_movements`), execuções auxiliares
 * (`fdp_auxiliary_executions`) e pendências operacionais
 * (`fdp_operational_pending_items`) — mais as aprovações, a triagem e as falhas
 * de integração que exigem decisão humana. Cada um com sua tela, seu status e
 * seu jeito de dizer "vencido".
 *
 * A tentação seria fundir as tabelas. Seria errado: elas guardam regras de
 * negócio diferentes, com constraints e imutabilidades próprias, e uma fusão
 * destrutiva jogaria fora invariantes que o banco impõe hoje. O que o usuário
 * precisa não é de uma tabela única — é de **uma resposta única** para "o que
 * está comigo?".
 *
 * Então isto é uma **camada de leitura**, e só. Nenhuma escrita passa por aqui,
 * nenhum objeto é migrado, e cada item continua sendo resolvido na tela do
 * módulo que o governa — o `href` leva para lá (§9).
 *
 * ## Uma consulta, não seis
 *
 * As fontes permitidas entram em um `UNION ALL` e o banco faz o recorte, a
 * ordenação e o corte de página. A alternativa — consultar cada fonte e juntar
 * em memória — obriga a trazer `limite` linhas de **cada** fonte para poder
 * escolher as `limite` primeiras do conjunto, e o custo cresce com o número de
 * fontes, não com o tamanho da página. É o N+1 clássico, disfarçado de
 * paralelismo (§12).
 *
 * ## Paginação por cursor
 *
 * A fila muda enquanto a pessoa lê. "Página 2" numerada devolveria itens
 * repetidos e puliria outros; o cursor é a posição exata na ordenação, e
 * continua de onde parou. Ele carrega a tupla inteira da ordenação — urgência,
 * prazo, criação e identificador — porque só o conjunto é único.
 *
 * O que este arquivo institui, e é o ponto que importa para o futuro (§93): a
 * partir daqui, uma funcionalidade nova que produza trabalho **registra uma
 * fonte aqui** em vez de criar o quinto objeto paralelo com a quinta tela.
 */
import type { Capability } from "./authorization.ts";

/** Contrato de leitura. Um item, venha de onde vier, se descreve assim. */
export type WorkItem = {
  id: string;
  /** Qual objeto originou: `card`, `movement`, `auxiliary`, `pending_item`… */
  sourceType: WorkItemSource;
  sourceId: string;
  title: string;
  description?: string;
  status: string;
  /** Rótulo do status em português; o usuário não lê enum. */
  statusLabel: string;
  priority?: string;
  priorityLabel: string;
  companyId?: string;
  companyName?: string;
  employeeId?: string;
  assigneeId?: string;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  processId?: string;
  processStep?: string;
  /** De onde o item veio: manual, integração, processo… (§5) */
  origin: string;
  originLabel: string;
  /** O que trava este item agora, quando há algo (§5). */
  blockedReason?: string;
  /** A ação que destrava, em português (§5). */
  nextAction: string;
  /** Destino no painel — deep link real (§10). */
  href: string;
  /** `critical` quando já venceu ou bloqueia fechamento. */
  tone: "critical" | "warning" | "neutral";
};

export type WorkItemSource =
  | "card"
  | "movement"
  | "approval"
  | "auxiliary"
  | "pending_item"
  | "triage"
  | "integration_failure";

export type WorkItemScope = "mine" | "team";

/**
 * Fonte de trabalho.
 *
 * Declarativa pelo mesmo motivo do `action-center`: um indicador só existe se
 * houver consulta real por trás e tela para onde ir. O que muda aqui é que o
 * resultado são **itens**, não contagens — "o que está comigo hoje" é uma
 * lista, não um número.
 *
 * Toda fonte devolve exatamente as mesmas dezesseis colunas, na mesma ordem: é
 * o que permite o `UNION ALL`. Uma coluna a mais em uma fonte só quebraria a
 * união inteira, e por isso a ordem está escrita e coberta por teste.
 *
 * `{{company}}` recebe o filtro de empresa do usuário e `{{mine}}` o recorte
 * pessoal. Nenhum dos dois é interpolado com valor: eles viram condição com
 * parâmetro, montada por `buildWorkItemQuery`.
 */
export type WorkItemSourceDefinition = {
  key: WorkItemSource;
  label: string;
  capability: Capability;
  /** Coluna de empresa para o escopo; vazio quando a fonte não é por empresa. */
  companyColumn: string;
  /** Condição que recorta "está comigo"; vazio quando a fonte não tem responsável. */
  mineCondition: string;
  /** Quantos parâmetros `?` a condição pessoal consome. */
  mineParameters: number;
  sql: string;
};

/** As colunas que toda fonte precisa devolver, na ordem exata da união. */
export const WORK_ITEM_COLUMNS = [
  "source_type", "source_id", "title", "description", "priority", "company_id",
  "company_name", "employee_id", "due_at", "created_at", "updated_at", "status",
  "process_id", "process_step", "process_version", "origin",
] as const;

export const workItemSources: readonly WorkItemSourceDefinition[] = [
  {
    key: "card",
    label: "Demandas",
    capability: "cards.read",
    companyColumn: "c.company_id",
    mineCondition: "EXISTS (SELECT 1 FROM fdp_card_assignees ca WHERE ca.card_id = c.id AND ca.user_id = ?)",
    mineParameters: 1,
    sql: `SELECT 'card' AS source_type, c.id AS source_id, c.title, c.description,
        c.priority, c.company_id, COALESCE(NULLIF(co.trade_name, ''), co.legal_name, c.company) AS company_name,
        NULL::text AS employee_id, c.due_at, c.created_at, c.updated_at,
        CASE WHEN c.closed_at IS NOT NULL THEN 'closed' ELSE c.sla_status END AS status,
        c.process_definition_id AS process_id, c.current_step_id AS process_step,
        c.process_version_number AS process_version,
        COALESCE(NULLIF(c.source_type, ''), 'manual') AS origin
      FROM fdp_cards c
      LEFT JOIN fdp_companies co ON co.workspace_id = c.workspace_id AND co.id = c.company_id
      WHERE c.workspace_id = ? AND c.archived = 0 AND c.closed_at IS NULL {{company}} {{mine}}`,
  },
  {
    key: "approval",
    label: "Aprovações",
    capability: "approvals.read",
    companyColumn: "m.company_id",
    mineCondition: "s.approver_user_id = ?",
    mineParameters: 1,
    sql: `SELECT 'approval' AS source_type, s.id AS source_id,
        m.title, '' AS description, 'high' AS priority, m.company_id,
        COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name,
        m.employee_id, m.effective_date::timestamptz AS due_at, s.created_at, s.updated_at,
        s.status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version,
        'operacao' AS origin
      FROM fdp_movement_approval_steps s
      JOIN fdp_employee_movements m ON m.workspace_id = s.workspace_id AND m.id = s.movement_id
      LEFT JOIN fdp_companies co ON co.workspace_id = m.workspace_id AND co.id = m.company_id
      WHERE s.workspace_id = ? AND s.status = 'pending' {{company}} {{mine}}`,
  },
  {
    key: "movement",
    label: "Movimentações",
    capability: "movements.read",
    companyColumn: "m.company_id",
    mineCondition: "m.requested_by = ?",
    mineParameters: 1,
    sql: `SELECT 'movement' AS source_type, m.id AS source_id, m.title, '' AS description,
        'normal' AS priority, m.company_id,
        COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name,
        m.employee_id, m.effective_date::timestamptz AS due_at, m.created_at, m.updated_at,
        m.status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version,
        'operacao' AS origin
      FROM fdp_employee_movements m
      LEFT JOIN fdp_companies co ON co.workspace_id = m.workspace_id AND co.id = m.company_id
      WHERE m.workspace_id = ? AND m.status IN ('draft', 'pending_approval', 'rejected') {{company}} {{mine}}`,
  },
  {
    key: "auxiliary",
    label: "Entregas auxiliares",
    capability: "benefits.read",
    companyColumn: "e.company_id",
    mineCondition: "e.owner_user_id = ?",
    mineParameters: 1,
    sql: `SELECT 'auxiliary' AS source_type, e.id AS source_id, e.title, e.module_type AS description,
        'normal' AS priority, e.company_id,
        COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name,
        NULL::text AS employee_id, e.due_date::timestamptz AS due_at, e.created_at, e.updated_at,
        e.status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version,
        'auxiliares' AS origin
      FROM fdp_auxiliary_executions e
      LEFT JOIN fdp_companies co ON co.workspace_id = e.workspace_id AND co.id = e.company_id
      WHERE e.workspace_id = ? AND e.status IN ('draft', 'pending_approval', 'rejected') {{company}} {{mine}}`,
  },
  {
    key: "pending_item",
    label: "Pendências operacionais",
    capability: "pending_items.read",
    companyColumn: "p.company_id",
    mineCondition: "p.owner_user_id = ?",
    mineParameters: 1,
    sql: `SELECT 'pending_item' AS source_type, p.id AS source_id, p.title,
        p.source_type AS description,
        CASE WHEN p.blocking = 1 THEN 'urgent' ELSE 'normal' END AS priority, p.company_id,
        COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name,
        NULL::text AS employee_id, p.due_date::timestamptz AS due_at, p.created_at, p.updated_at,
        p.status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version,
        'operacao' AS origin
      FROM fdp_operational_pending_items p
      LEFT JOIN fdp_companies co ON co.workspace_id = p.workspace_id AND co.id = p.company_id
      WHERE p.workspace_id = ? AND p.status IN ('open', 'in_progress') {{company}} {{mine}}`,
  },
  {
    key: "triage",
    label: "Triagem",
    capability: "integrations.status.read",
    /* A triagem chega antes de o sistema saber a empresa — é justamente o que
       falta identificar (§14). Recortá-la por empresa esconderia dela quem tem
       escopo, e o item ficaria invisível para todo mundo. */
    companyColumn: "",
    mineCondition: "",
    mineParameters: 0,
    sql: `SELECT 'triage' AS source_type, t.id AS source_id,
        COALESCE(NULLIF(t.employee_name, ''), 'Entrada não identificada') AS title,
        t.movement_kind AS description, 'high' AS priority,
        NULL::text AS company_id, NULL::text AS company_name,
        t.employee_id, NULL::timestamptz AS due_at, t.created_at, t.updated_at,
        'pending' AS status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version,
        'teams' AS origin
      FROM fdp_movement_suggestions t
      WHERE t.workspace_id = ? AND t.status = 'pending'`,
  },
  {
    key: "integration_failure",
    label: "Falhas de integração",
    capability: "integrations.status.read",
    /* Falha de execução não é de uma empresa: ela é do conector, que atende o
       grupo inteiro. Recortá-la por empresa a esconderia de quem pode resolvê-la. */
    companyColumn: "",
    mineCondition: "",
    mineParameters: 0,
    /* Execução que esgotou as tentativas exige decisão humana (§4, §35): ela não
       segue sozinha e não desaparece. Aparecer aqui é o que impede que ela fique
       esperando alguém abrir a tela de integrações por acaso. */
    sql: `SELECT 'integration_failure' AS source_type, j.id AS source_id,
        'Execução de ' || i.display_name || ' esgotou as tentativas' AS title,
        COALESCE(NULLIF(j.last_error_message, ''), 'Falha sem detalhe registrado') AS description,
        'urgent' AS priority,
        NULL::text AS company_id, NULL::text AS company_name, NULL::text AS employee_id,
        j.completed_at AS due_at, j.created_at, j.updated_at,
        'dead_letter' AS status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version,
        i.channel AS origin
      FROM fdp_integration_jobs j
      JOIN fdp_integrations i ON i.workspace_id = j.workspace_id AND i.id = j.integration_id
      WHERE j.workspace_id = ? AND j.status = 'dead_letter'`,
  },
];

/* -------------------------------------------------------------------------- *
 * Tradução para o contrato
 * -------------------------------------------------------------------------- */

const STATUS_LABELS: Record<string, string> = {
  safe: "No prazo",
  warning: "Vence hoje",
  overdue: "Vencida",
  paused: "Pausada",
  completed: "Concluída",
  closed: "Encerrada",
  draft: "Rascunho",
  pending: "Aguardando",
  pending_approval: "Aguardando aprovação",
  rejected: "Rejeitada",
  open: "Aberta",
  in_progress: "Em andamento",
  blocked: "Bloqueada",
  dead_letter: "Falhou e parou",
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: "Urgente",
  high: "Alta",
  normal: "Normal",
  low: "Baixa",
};

const ORIGIN_LABELS: Record<string, string> = {
  manual: "Criada no Vinculato",
  operacao: "Operação DP",
  auxiliares: "Módulos auxiliares",
  process: "Processo publicado",
  teams: "Microsoft Teams",
  tangerino: "Tangerino",
  solides: "Sólides",
  sankhya_browser: "Sankhya",
  "integracao:tangerino": "Tangerino",
  "integracao:solides": "Sólides",
  "integracao:teams": "Microsoft Teams",
};

export function originLabel(origin: string) {
  return ORIGIN_LABELS[origin] ?? (origin.startsWith("integracao:") ? origin.slice("integracao:".length) : origin);
}

/**
 * O que fazer com este item (§5, §9).
 *
 * A Central não resolve nada; ela encaminha. Dizer "abrir a demanda" quando o
 * que falta é aprovar, ou "aprovar" quando o item é uma falha de conector, faz
 * a pessoa clicar e descobrir na tela seguinte que não era aquilo — que é o
 * jeito mais rápido de ensinar alguém a ignorar uma lista.
 */
const NEXT_ACTIONS: Record<WorkItemSource, string> = {
  card: "Abrir a demanda e avançar a etapa",
  approval: "Decidir a aprovação",
  movement: "Completar e enviar para aprovação",
  auxiliary: "Concluir a entrega da competência",
  pending_item: "Resolver a pendência do fechamento",
  triage: "Confirmar de quem é a entrada",
  integration_failure: "Verificar o agente e reprocessar",
};

/**
 * Destino no painel.
 *
 * Todo endereço aqui precisa existir de verdade (§10) — um `href` que leva a
 * lugar nenhum é pior do que não ter link, porque a pessoa clica, não acontece
 * nada e ela conclui que o produto está quebrado.
 *
 * Por isso os destinos são as telas que já existem: aprovação, movimentação e
 * pendência abrem em **Operação DP**, que é onde elas são resolvidas; triagem
 * abre na **Central de Triagem**; e falha de execução abre na **Central de
 * Agentes**, que é onde se reprocessa. O identificador vai na querystring para
 * a tela poder destacar o item.
 */
export function workItemHref(source: WorkItemSource, id: string): string {
  const item = encodeURIComponent(id);
  switch (source) {
    case "card": return `/painel/demandas/${item}`;
    case "approval": return `/painel/operacao?aprovacao=${item}`;
    case "movement": return `/painel/operacao?movimentacao=${item}`;
    case "pending_item": return `/painel/operacao?pendencia=${item}`;
    case "auxiliary": return `/painel/auxiliares?execucao=${item}`;
    case "triage": return `/painel/triagem/movimentacao-${item}`;
    case "integration_failure": return `/painel/agentes?execucao=${item}`;
    default: return "/painel";
  }
}

function toneOf(status: string, dueAt: string | null, priority: string, today: string): WorkItem["tone"] {
  if (status === "overdue" || status === "blocked" || status === "dead_letter") return "critical";
  if (priority === "urgent") return "critical";
  if (dueAt) {
    const due = dueAt.slice(0, 10);
    if (due < today) return "critical";
    if (due === today) return "warning";
  }
  if (status === "warning" || status === "pending_approval" || status === "rejected") return "warning";
  return "neutral";
}

/**
 * Por que este item está travado, quando está (§5, §44).
 *
 * Só o que se sabe pela linha: a Central não abre o processo para descobrir o
 * bloqueio da etapa — isso é trabalho da tela da demanda, que tem o motivo
 * exato. Aqui a frase existe para a pessoa decidir se abre agora ou depois.
 */
function blockedReasonOf(status: string, dueAt: string | null, today: string): string {
  if (status === "dead_letter") return "A execução esgotou as tentativas e não segue sozinha.";
  if (status === "pending_approval") return "Aguardando decisão de quem aprova.";
  if (status === "rejected") return "Foi recusada e precisa de correção.";
  if (status === "blocked") return "Bloqueada por uma pendência do fechamento.";
  if (dueAt && dueAt.slice(0, 10) < today) return "O prazo já venceu.";
  return "";
}

const text = (value: unknown) => (value == null ? "" : String(value));

/** Converte a linha crua na forma que a tela consome. */
export function toWorkItem(row: Record<string, unknown>, today = new Date().toISOString().slice(0, 10)): WorkItem {
  const sourceType = text(row.source_type) as WorkItemSource;
  const sourceId = text(row.source_id);
  const status = text(row.status);
  const dueAt = row.due_at ? text(row.due_at) : "";
  const priority = text(row.priority) || "normal";
  const origin = text(row.origin) || "manual";
  const createdAt = text(row.created_at);
  return {
    id: `${sourceType}:${sourceId}`,
    sourceType,
    sourceId,
    title: text(row.title),
    description: text(row.description) || undefined,
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    priority,
    priorityLabel: PRIORITY_LABELS[priority] ?? priority,
    companyId: text(row.company_id) || undefined,
    companyName: text(row.company_name) || undefined,
    employeeId: text(row.employee_id) || undefined,
    dueAt: dueAt || undefined,
    createdAt,
    updatedAt: text(row.updated_at) || createdAt,
    processId: text(row.process_id) || undefined,
    processStep: text(row.process_step) || undefined,
    origin,
    originLabel: originLabel(origin),
    blockedReason: blockedReasonOf(status, dueAt || null, today) || undefined,
    nextAction: NEXT_ACTIONS[sourceType] ?? "Abrir o item",
    href: workItemHref(sourceType, sourceId),
    tone: toneOf(status, dueAt || null, priority, today),
  };
}

/**
 * Ordem da lista: o que trava primeiro, e o mais antigo antes do mais novo.
 *
 * Mantida em TypeScript além do SQL porque a mesma ordenação precisa valer para
 * listas já carregadas — a home, por exemplo, que mostra os primeiros itens sem
 * paginar.
 */
export function sortWorkItems(items: readonly WorkItem[]): WorkItem[] {
  const toneRank = { critical: 0, warning: 1, neutral: 2 } as const;
  return [...items].sort((left, right) => {
    if (toneRank[left.tone] !== toneRank[right.tone]) return toneRank[left.tone] - toneRank[right.tone];
    if (Boolean(left.dueAt) !== Boolean(right.dueAt)) return left.dueAt ? -1 : 1;
    if (left.dueAt && right.dueAt && left.dueAt !== right.dueAt) return left.dueAt < right.dueAt ? -1 : 1;
    return left.createdAt < right.createdAt ? -1 : 1;
  });
}

/* -------------------------------------------------------------------------- *
 * Filtros, ordenação e agrupamento
 * -------------------------------------------------------------------------- */

export type WorkItemDueWindow = "" | "overdue" | "today" | "week";
export type WorkItemSort = "urgency" | "due" | "priority" | "created" | "updated";
export type WorkItemGroup = "" | "source" | "process" | "company" | "due" | "status" | "origin";

export const workItemSorts: ReadonlyArray<{ key: WorkItemSort; label: string }> = [
  { key: "urgency", label: "Urgência" },
  { key: "due", label: "Prazo" },
  { key: "priority", label: "Prioridade" },
  { key: "created", label: "Criação" },
  { key: "updated", label: "Última atualização" },
];

export const workItemGroups: ReadonlyArray<{ key: WorkItemGroup; label: string }> = [
  { key: "", label: "Sem agrupamento" },
  { key: "source", label: "Origem do trabalho" },
  { key: "process", label: "Processo" },
  { key: "company", label: "Empresa" },
  { key: "status", label: "Situação" },
  { key: "due", label: "Prazo" },
  { key: "origin", label: "De onde veio" },
];

export const workItemDueWindows: ReadonlyArray<{ key: WorkItemDueWindow; label: string }> = [
  { key: "", label: "Qualquer prazo" },
  { key: "overdue", label: "Vencidos" },
  { key: "today", label: "Hoje" },
  { key: "week", label: "Esta semana" },
];

export type WorkItemFilters = {
  scope: WorkItemScope;
  due: WorkItemDueWindow;
  sources: readonly WorkItemSource[];
  companyId: string;
  processId: string;
  priority: string;
  status: string;
  origin: string;
};

export const emptyWorkItemFilters: WorkItemFilters = {
  scope: "mine", due: "", sources: [], companyId: "", processId: "",
  priority: "", status: "", origin: "",
};

/**
 * Urgência calculada no banco.
 *
 * Precisa estar no SQL, e não em TypeScript, porque é por ela que a lista é
 * ordenada e paginada: calcular em memória obrigaria a trazer a fila inteira
 * para descobrir quais são os vinte primeiros. É a mesma regra de `toneOf` —
 * escrita duas vezes, coberta por teste, porque a alternativa é paginar errado.
 */
const URGENCY_SQL = `CASE
    WHEN status IN ('overdue', 'blocked', 'dead_letter') OR priority = 'urgent'
      OR (due_at IS NOT NULL AND due_at::date < CURRENT_DATE) THEN 0
    WHEN (due_at IS NOT NULL AND due_at::date = CURRENT_DATE)
      OR status IN ('warning', 'pending_approval', 'rejected') THEN 1
    ELSE 2 END`;

/** Prazo comparável: sem prazo vai para o fim, e não some da ordenação. */
const DUE_SORT_SQL = "COALESCE(due_at, 'infinity'::timestamptz)";

const PRIORITY_SQL = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

/**
 * Cada ordenação como uma tupla de quatro colunas.
 *
 * Quatro, e sempre as mesmas duas no fim, porque o cursor precisa de uma ordem
 * **total**: dois itens com a mesma urgência e o mesmo prazo, sem critério de
 * desempate, apareceriam em ordem diferente a cada consulta — e a paginação
 * pularia um e repetiria o outro sem erro nenhum.
 *
 * `kind` diz o tipo de cada uma das duas primeiras, que é o que o cursor
 * precisa saber para converter o texto de volta na hora da comparação.
 */
type SortDefinition = {
  first: { sql: string; kind: "integer" | "timestamptz" };
  second: { sql: string; kind: "integer" | "timestamptz" };
  /** `true` quando a ordem é decrescente — o mais recente primeiro. */
  descending?: boolean;
};

const SORT_DEFINITIONS: Record<WorkItemSort, SortDefinition> = {
  urgency: { first: { sql: URGENCY_SQL, kind: "integer" }, second: { sql: DUE_SORT_SQL, kind: "timestamptz" } },
  due: { first: { sql: DUE_SORT_SQL, kind: "timestamptz" }, second: { sql: URGENCY_SQL, kind: "integer" } },
  priority: { first: { sql: PRIORITY_SQL, kind: "integer" }, second: { sql: DUE_SORT_SQL, kind: "timestamptz" } },
  created: { first: { sql: "created_at", kind: "timestamptz" }, second: { sql: "created_at", kind: "timestamptz" }, descending: true },
  updated: { first: { sql: "updated_at", kind: "timestamptz" }, second: { sql: "updated_at", kind: "timestamptz" }, descending: true },
};

function orderBy(sort: WorkItemSort) {
  const definition = SORT_DEFINITIONS[sort];
  return definition.descending
    ? `${definition.first.sql} DESC, source_id`
    : `${definition.first.sql}, ${definition.second.sql}, created_at, source_id`;
}

/**
 * Cursor opaco.
 *
 * Carrega a tupla inteira da ordenação porque só o conjunto é único: dois itens
 * podem ter a mesma urgência e o mesmo prazo, e um cursor por uma coluna só
 * pularia um deles ou o repetiria para sempre.
 */
export function encodeWorkCursor(values: readonly string[]) {
  /* Separador que não pode aparecer em identificador nem em data ISO. */
  return Buffer.from(values.join("\u0000"), "utf8").toString("base64url");
}

export function decodeWorkCursor(cursor: string): string[] {
  if (!cursor) return [];
  try {
    /* `Buffer.from` é leniente e aceita quase qualquer texto, devolvendo bytes
       sem sentido em vez de erro — um cursor adulterado viraria uma condição
       silenciosamente errada. Reencodar e comparar é o que transforma isso em
       recusa. */
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) return [];
    const parts = decoded.split("\u0000");
    return parts.every((part) => part.length <= 200) ? parts : [];
  } catch {
    return [];
  }
}

/** A chave de agrupamento de um item, já em português (§8). */
export function workItemGroupKey(item: WorkItem, group: WorkItemGroup, today = new Date().toISOString().slice(0, 10)) {
  switch (group) {
    case "source": return workItemSources.find((source) => source.key === item.sourceType)?.label ?? item.sourceType;
    case "process": return item.processId ? (item.processStep || "Etapa atual") : "Sem processo";
    case "company": return item.companyName || "Sem empresa";
    case "status": return item.statusLabel;
    case "origin": return item.originLabel;
    case "due": {
      if (!item.dueAt) return "Sem prazo";
      const due = item.dueAt.slice(0, 10);
      if (due < today) return "Vencidos";
      if (due === today) return "Hoje";
      return due <= addDays(today, 7) ? "Esta semana" : "Depois";
    }
    default: return "";
  }
}

function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- *
 * Construção da consulta
 * -------------------------------------------------------------------------- */

/**
 * Monta a consulta de uma fonte com escopo de empresa e recorte pessoal.
 *
 * O escopo de empresa entra **no SQL**, não em filtro de memória depois de
 * carregar tudo: linha que a pessoa não pode ver não deve nem sair do banco
 * (§50).
 */
export function buildWorkItemQuery(input: {
  source: WorkItemSourceDefinition;
  workspaceId: string;
  userId: string;
  scope: WorkItemScope;
  companyIds: readonly string[] | null;
}) {
  const parameters: unknown[] = [input.workspaceId];
  let sql = input.source.sql;

  if (input.companyIds && input.source.companyColumn) {
    if (input.companyIds.length === 0) {
      // Sem nenhuma empresa liberada, a fonte por empresa não devolve nada — e
      // dizer isso em SQL é mais barato e mais seguro do que filtrar depois.
      sql = sql.replace("{{company}}", "AND false");
    } else {
      const placeholders = input.companyIds.map(() => "?").join(", ");
      sql = sql.replace("{{company}}", `AND ${input.source.companyColumn} IN (${placeholders})`);
      parameters.push(...input.companyIds);
    }
  } else {
    sql = sql.replace("{{company}}", "");
  }

  if (input.scope === "mine" && input.source.mineCondition) {
    sql = sql.replace("{{mine}}", `AND ${input.source.mineCondition}`);
    for (let index = 0; index < input.source.mineParameters; index += 1) parameters.push(input.userId);
  } else {
    sql = sql.replace("{{mine}}", "");
  }

  return { sql, parameters };
}

export type WorkQuery = { sql: string; parameters: unknown[] };

/**
 * A consulta da Central: uma união, um recorte, uma página.
 *
 * As fontes permitidas viram um `UNION ALL`, os filtros do usuário se aplicam
 * ao conjunto e o banco devolve exatamente a página pedida. Sem fontes
 * permitidas a consulta não é montada — quem chama devolve lista vazia em vez
 * de perguntar ao banco por nada.
 */
export function buildWorkCenterQuery(input: {
  sources: readonly WorkItemSourceDefinition[];
  workspaceId: string;
  userId: string;
  companyIds: readonly string[] | null;
  filters: WorkItemFilters;
  sort: WorkItemSort;
  cursor: readonly string[];
  limit: number;
}): WorkQuery | null {
  const selected = input.filters.sources.length
    ? input.sources.filter((source) => input.filters.sources.includes(source.key))
    : input.sources;
  if (!selected.length) return null;

  const parameters: unknown[] = [];
  const unions = selected.map((source) => {
    const built = buildWorkItemQuery({
      source, workspaceId: input.workspaceId, userId: input.userId,
      scope: input.filters.scope, companyIds: input.companyIds,
    });
    parameters.push(...built.parameters);
    return built.sql;
  });

  const conditions: string[] = [];
  const { filters } = input;
  if (filters.companyId) { conditions.push("company_id = ?"); parameters.push(filters.companyId); }
  if (filters.processId) { conditions.push("process_id = ?"); parameters.push(filters.processId); }
  if (filters.priority) { conditions.push("priority = ?"); parameters.push(filters.priority); }
  if (filters.status) { conditions.push("status = ?"); parameters.push(filters.status); }
  if (filters.origin) { conditions.push("origin = ?"); parameters.push(filters.origin); }
  if (filters.due === "overdue") conditions.push("due_at IS NOT NULL AND due_at::date < CURRENT_DATE");
  if (filters.due === "today") conditions.push("due_at IS NOT NULL AND due_at::date = CURRENT_DATE");
  if (filters.due === "week") {
    conditions.push("due_at IS NOT NULL AND due_at::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7");
  }

  const order = orderBy(input.sort);
  const cursorClause = cursorCondition(input.sort, input.cursor, parameters);
  if (cursorClause) conditions.push(cursorClause);

  const limit = Math.max(1, Math.min(WORK_ITEM_MAX_PAGE, Math.trunc(input.limit) || WORK_ITEM_DEFAULT_PAGE));
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return {
    sql: `SELECT *, ${URGENCY_SQL} AS urgency, ${DUE_SORT_SQL} AS due_sort, ${PRIORITY_SQL} AS priority_rank
        FROM (${unions.join(" UNION ALL ")}) items
        ${where} ORDER BY ${order} LIMIT ${limit + 1}`,
    parameters,
  };
}

/**
 * A condição do cursor.
 *
 * Comparação de tupla, que o PostgreSQL resolve em uma expressão só. O prazo
 * usa `COALESCE(..., 'infinity')` justamente para poder entrar nela: `NULL` em
 * comparação de tupla devolve `NULL`, e a página seguinte viria vazia sem erro
 * nenhum — o modo de falhar mais difícil de perceber.
 */
function cursorCondition(sort: WorkItemSort, cursor: readonly string[], parameters: unknown[]) {
  const definition = SORT_DEFINITIONS[sort];
  if (definition.descending) {
    if (cursor.length < 2) return "";
    parameters.push(cursor[0], cursor[0], cursor[1]);
    return `(${definition.first.sql} < ?::timestamptz OR (${definition.first.sql} = ?::timestamptz AND source_id > ?))`;
  }
  if (cursor.length < 4) return "";
  parameters.push(cursor[0], cursor[1], cursor[2], cursor[3]);
  return `(${definition.first.sql}, ${definition.second.sql}, created_at, source_id)`
    + ` > (?::${definition.first.kind}, ?::${definition.second.kind}, ?::timestamptz, ?)`;
}

/** A coluna do resultado que corresponde a cada expressão de ordenação. */
const SORT_COLUMNS: Record<WorkItemSort, [string, string]> = {
  urgency: ["urgency", "due_sort"],
  due: ["due_sort", "urgency"],
  priority: ["priority_rank", "due_sort"],
  created: ["created_at", "created_at"],
  updated: ["updated_at", "updated_at"],
};

/** O cursor que aponta para depois deste item, na ordenação pedida. */
export function cursorForRow(sort: WorkItemSort, row: Record<string, unknown>) {
  const [first, second] = SORT_COLUMNS[sort];
  const value = (key: string) => text(row[key]);
  if (SORT_DEFINITIONS[sort].descending) return encodeWorkCursor([value(first), value("source_id")]);
  return encodeWorkCursor([value(first), value(second), value("created_at"), value("source_id")]);
}

export const WORK_ITEM_MAX_PAGE = 100;
export const WORK_ITEM_DEFAULT_PAGE = 25;

/**
 * Contadores agregados (§11).
 *
 * Uma consulta sobre a mesma união, sem paginar: contar no navegador exigiria
 * baixar a fila inteira só para exibir seis números — que é a definição do
 * problema que a paginação existe para resolver.
 */
export function buildWorkCountsQuery(input: {
  sources: readonly WorkItemSourceDefinition[];
  workspaceId: string;
  userId: string;
  companyIds: readonly string[] | null;
  scope: WorkItemScope;
}): WorkQuery | null {
  if (!input.sources.length) return null;
  const parameters: unknown[] = [];
  const unions = input.sources.map((source) => {
    const built = buildWorkItemQuery({
      source, workspaceId: input.workspaceId, userId: input.userId,
      scope: input.scope, companyIds: input.companyIds,
    });
    parameters.push(...built.parameters);
    return built.sql;
  });

  return {
    sql: `SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE due_at IS NOT NULL AND due_at::date < CURRENT_DATE)::int AS overdue,
        count(*) FILTER (WHERE due_at IS NOT NULL AND due_at::date = CURRENT_DATE)::int AS today,
        count(*) FILTER (WHERE status IN ('blocked', 'rejected'))::int AS blocked,
        count(*) FILTER (WHERE status = 'pending_approval' OR source_type = 'approval')::int AS awaiting_approval,
        count(*) FILTER (WHERE source_type = 'triage')::int AS triage,
        count(*) FILTER (WHERE source_type = 'integration_failure')::int AS failures
      FROM (${unions.join(" UNION ALL ")}) items`,
    parameters,
  };
}

/** Contagem por grupo, para o agrupamento não mentir fora da página (§8). */
export function buildWorkGroupQuery(input: {
  sources: readonly WorkItemSourceDefinition[];
  workspaceId: string;
  userId: string;
  companyIds: readonly string[] | null;
  scope: WorkItemScope;
  group: Exclude<WorkItemGroup, "">;
}): WorkQuery | null {
  if (!input.sources.length) return null;
  const parameters: unknown[] = [];
  const unions = input.sources.map((source) => {
    const built = buildWorkItemQuery({
      source, workspaceId: input.workspaceId, userId: input.userId,
      scope: input.scope, companyIds: input.companyIds,
    });
    parameters.push(...built.parameters);
    return built.sql;
  });

  const expression: Record<Exclude<WorkItemGroup, "">, string> = {
    source: "source_type",
    process: "COALESCE(NULLIF(process_id, ''), 'sem-processo')",
    company: "COALESCE(NULLIF(company_name, ''), 'Sem empresa')",
    status: "status",
    origin: "origin",
    due: `CASE
        WHEN due_at IS NULL THEN 'Sem prazo'
        WHEN due_at::date < CURRENT_DATE THEN 'Vencidos'
        WHEN due_at::date = CURRENT_DATE THEN 'Hoje'
        WHEN due_at::date <= CURRENT_DATE + 7 THEN 'Esta semana'
        ELSE 'Depois' END`,
  };

  return {
    sql: `SELECT ${expression[input.group]} AS grupo, count(*)::int AS total
        FROM (${unions.join(" UNION ALL ")}) items
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30`,
    parameters,
  };
}
