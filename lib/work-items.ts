/**
 * Contrato comum de trabalho e a Central de Trabalho (§30, §31, §32).
 *
 * A auditoria contou pelo menos quatro objetos que significam "alguém precisa
 * fazer alguma coisa": demandas (`fdp_cards`), movimentações
 * (`fdp_employee_movements`), execuções auxiliares
 * (`fdp_auxiliary_executions`) e pendências operacionais
 * (`fdp_operational_pending_items`) — mais as aprovações e a triagem que
 * chegam pelas integrações. Cada um com sua tela, seu status e seu jeito de
 * dizer "vencido".
 *
 * A tentação seria fundir as quatro tabelas. Seria errado agora: elas guardam
 * regras de negócio diferentes, com constraints e imutabilidades próprias, e
 * uma fusão destrutiva jogaria fora invariantes que o banco impõe hoje. O que o
 * usuário precisa não é de uma tabela única — é de **uma resposta única** para
 * "o que está comigo?".
 *
 * Então isto é uma **camada de leitura**, e só. Nenhuma escrita passa por aqui,
 * nenhum objeto é migrado, e cada item continua sendo resolvido na tela do
 * módulo que o governa — o `href` leva para lá.
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
  companyId?: string;
  companyName?: string;
  employeeId?: string;
  assigneeId?: string;
  dueAt?: string;
  createdAt: string;
  processId?: string;
  processStep?: string;
  /** Destino no painel — deep link real (§43). */
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
  | "triage";

export type WorkItemScope = "mine" | "team";

/**
 * Fonte de trabalho.
 *
 * Declarativa pelo mesmo motivo do `action-center`: um indicador só existe se
 * houver consulta real por trás e tela para onde ir. O que muda aqui é que o
 * resultado são **itens**, não contagens — "o que está comigo hoje" é uma
 * lista, não um número.
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
        NULL::text AS employee_id, c.due_at, c.created_at,
        CASE WHEN c.closed_at IS NOT NULL THEN 'closed' ELSE c.sla_status END AS status,
        c.process_definition_id AS process_id, c.current_step_id AS process_step,
        c.process_version_number AS process_version
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
        m.employee_id, m.effective_date::timestamptz AS due_at, s.created_at,
        s.status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version
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
        m.employee_id, m.effective_date::timestamptz AS due_at, m.created_at,
        m.status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version
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
        NULL::text AS employee_id, e.due_date::timestamptz AS due_at, e.created_at,
        e.status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version
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
        NULL::text AS employee_id, p.due_date::timestamptz AS due_at, p.created_at,
        p.status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version
      FROM fdp_operational_pending_items p
      LEFT JOIN fdp_companies co ON co.workspace_id = p.workspace_id AND co.id = p.company_id
      WHERE p.workspace_id = ? AND p.status IN ('open', 'in_progress') {{company}} {{mine}}`,
  },
  {
    key: "triage",
    label: "Triagem",
    capability: "integrations.status.read",
    /* A triagem chega antes de o sistema saber a empresa — é justamente o que
       falta identificar (§19). Recortá-la por empresa esconderia dela quem tem
       escopo, e o item ficaria invisível para todo mundo. */
    companyColumn: "",
    mineCondition: "",
    mineParameters: 0,
    sql: `SELECT 'triage' AS source_type, t.id AS source_id,
        COALESCE(NULLIF(t.employee_name, ''), 'Entrada não identificada') AS title,
        t.movement_kind AS description, 'high' AS priority,
        NULL::text AS company_id, NULL::text AS company_name,
        t.employee_id, NULL::timestamptz AS due_at, t.created_at,
        'pending' AS status, NULL::text AS process_id, NULL::text AS process_step, '' AS process_version
      FROM fdp_movement_suggestions t
      WHERE t.workspace_id = ? AND t.status = 'pending'`,
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
};

/**
 * Destino no painel.
 *
 * Todo endereço aqui precisa existir de verdade (§43, §44) — um `href` que leva
 * a lugar nenhum é pior do que não ter link, porque a pessoa clica, não acontece
 * nada e ela conclui que o produto está quebrado.
 *
 * Por isso os destinos são as telas que já existem: aprovação, movimentação e
 * pendência abrem em **Operação DP**, que é onde elas são resolvidas, e triagem
 * abre em **Integrações**, que é a casa operacional dos conectores e dos
 * eventos. O identificador vai na querystring para a tela poder destacar o item.
 */
export function workItemHref(source: WorkItemSource, id: string): string {
  const item = encodeURIComponent(id);
  switch (source) {
    case "card": return `/painel/demandas/${item}`;
    case "approval": return `/painel/operacao?aprovacao=${item}`;
    case "movement": return `/painel/operacao?movimentacao=${item}`;
    case "pending_item": return `/painel/operacao?pendencia=${item}`;
    case "auxiliary": return `/painel/auxiliares?execucao=${item}`;
    case "triage": return `/painel/integracoes?triagem=${item}`;
    default: return "/painel";
  }
}

function toneOf(status: string, dueAt: string | null, priority: string): WorkItem["tone"] {
  if (status === "overdue" || status === "blocked") return "critical";
  if (priority === "urgent") return "critical";
  if (dueAt) {
    const due = dueAt.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (due < today) return "critical";
    if (due === today) return "warning";
  }
  if (status === "warning" || status === "pending_approval" || status === "rejected") return "warning";
  return "neutral";
}

const text = (value: unknown) => (value == null ? "" : String(value));

/** Converte a linha crua na forma que a tela consome. */
export function toWorkItem(row: Record<string, unknown>): WorkItem {
  const sourceType = text(row.source_type) as WorkItemSource;
  const sourceId = text(row.source_id);
  const status = text(row.status);
  const dueAt = row.due_at ? text(row.due_at) : "";
  const priority = text(row.priority) || "normal";
  return {
    id: `${sourceType}:${sourceId}`,
    sourceType,
    sourceId,
    title: text(row.title),
    description: text(row.description) || undefined,
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    priority,
    companyId: text(row.company_id) || undefined,
    companyName: text(row.company_name) || undefined,
    employeeId: text(row.employee_id) || undefined,
    dueAt: dueAt || undefined,
    createdAt: text(row.created_at),
    processId: text(row.process_id) || undefined,
    processStep: text(row.process_step) || undefined,
    href: workItemHref(sourceType, sourceId),
    tone: toneOf(status, dueAt || null, priority),
  };
}

/**
 * Ordem da lista: o que trava primeiro, e o mais antigo antes do mais novo.
 *
 * Sem prazo vai para o fim — não porque não importe, mas porque item sem prazo
 * competindo com item vencido esconde o vencido.
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

/**
 * Monta a consulta de uma fonte com escopo de empresa e recorte pessoal.
 *
 * O escopo de empresa entra **no SQL**, não em filtro de memória depois de
 * carregar tudo: linha que a pessoa não pode ver não deve nem sair do banco.
 */
export function buildWorkItemQuery(input: {
  source: WorkItemSourceDefinition;
  workspaceId: string;
  userId: string;
  scope: WorkItemScope;
  companyIds: readonly string[] | null;
  limit: number;
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

  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit) || 50));
  return { sql: `${sql} ORDER BY created_at DESC LIMIT ${limit}`, parameters };
}
