import { ApiError } from "./api-errors.ts";
import type { WorkspaceRole } from "./fila-dp-types";

/**
 * Serviço central de workspaces acessíveis.
 *
 * Existe porque a regra estava espalhada: a resolução do contexto lia a
 * *preferência* do usuário sem olhar o ciclo de vida do workspace e, quando o
 * preferido não estava operacional, recusava a requisição inteira — mesmo que a
 * pessoa tivesse outro workspace ativo. Arquivar um grupo trancava o usuário
 * para fora de todos os outros.
 *
 * A partir daqui existe um cálculo só, usado pelo login, pelo carregamento do
 * painel, pelo seletor e pela troca de workspace.
 */

/** Estados em que um workspace é um contexto operacional válido. */
export const OPERATIONAL_WORKSPACE_STATUSES = new Set(["active"]);

/** Estados que existem, mas não operam. A distinção vira mensagem na tela. */
export const WORKSPACE_STATUS_LABELS: Record<string, string> = {
  active: "Ativo",
  suspended: "Suspenso",
  canceled: "Cancelado",
  archived: "Arquivado",
  // Exclusão pedida pelo cliente é reversível dentro do prazo, então o grupo
  // continua aparecendo na lista — rotulado — em vez de sumir. Sumir sem
  // explicação é o que faz o usuário achar que perdeu os dados.
  deleted: "Excluído",
};

export type AccessibleWorkspace = {
  id: string;
  name: string;
  timezone: string;
  status: string;
  statusReason: string;
  role: WorkspaceRole;
  isOwner: boolean;
  joinedAt: string;
  /** `true` quando o workspace pode ser usado como contexto de trabalho. */
  operational: boolean;
};

export type WorkspaceResolution =
  | { kind: "ok"; workspace: AccessibleWorkspace; switchedFrom: AccessibleWorkspace | null }
  | { kind: "none"; blocked: AccessibleWorkspace[] };

type Row = Record<string, unknown>;

const text = (value: unknown) => (value == null ? "" : String(value));

function toWorkspace(row: Row): AccessibleWorkspace {
  const status = text(row.status) || "active";
  return {
    id: text(row.id),
    name: text(row.name),
    timezone: text(row.timezone) || "America/Sao_Paulo",
    status,
    statusReason: text(row.status_reason),
    role: (text(row.role) || "guest") as WorkspaceRole,
    isOwner: row.is_owner === true || row.is_owner === 1 || row.is_owner === "t",
    joinedAt: text(row.joined_at),
    operational: OPERATIONAL_WORKSPACE_STATUSES.has(status),
  };
}

/**
 * Todos os workspaces em que o usuário tem associação, operacionais ou não.
 *
 * Os não operacionais vêm junto de propósito: a tela precisa poder dizer
 * "este grupo está arquivado" em vez de fingir que ele nunca existiu.
 */
export async function listAccessibleWorkspaces(
  d1: { prepare: (query: string) => { bind: (...args: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } } },
  userId: string,
): Promise<AccessibleWorkspace[]> {
  const rows = await d1.prepare(
    `SELECT w.id, w.name, w.timezone, w.status, w.status_reason, wm.role, wm.joined_at,
        (w.owner_user_id = wm.user_id) AS is_owner
      FROM fdp_workspaces w
      JOIN fdp_workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = ?
      ORDER BY (w.status = 'active') DESC, (w.owner_user_id = wm.user_id) DESC, wm.joined_at`,
  ).bind(userId).all<Row>();
  return rows.results.map(toWorkspace);
}

/**
 * Escolhe o contexto de trabalho a partir das associações e da preferência.
 *
 * Regras, nesta ordem:
 * 1. a preferência só vale se o workspace ainda for associado E operacional;
 * 2. caindo fora, escolhe o melhor candidato operacional de forma determinística
 *    (proprietário primeiro, depois associação mais antiga);
 * 3. sem nenhum operacional, devolve `none` com a lista do que existe e por quê
 *    não serve — nunca uma recusa genérica.
 *
 * `switchedFrom` permite a interface avisar que o contexto mudou sozinho, em vez
 * de trocar o grupo debaixo do usuário sem explicação.
 */
export function resolveActiveWorkspace(
  workspaces: AccessibleWorkspace[],
  preferredId: string | null,
): WorkspaceResolution {
  const operational = workspaces.filter((workspace) => workspace.operational);
  if (operational.length === 0) return { kind: "none", blocked: workspaces };

  const preferred = preferredId ? workspaces.find((workspace) => workspace.id === preferredId) ?? null : null;
  if (preferred?.operational) return { kind: "ok", workspace: preferred, switchedFrom: null };

  // A lista já chega ordenada por operacional, propriedade e antiguidade.
  return { kind: "ok", workspace: operational[0], switchedFrom: preferred };
}

/** Erro de "nenhum workspace utilizável", com o detalhe que a tela precisa. */
export function noAccessibleWorkspaceError(blocked: AccessibleWorkspace[]) {
  if (blocked.length === 0) {
    return ApiError.forbidden(
      "Sua conta ainda não está vinculada a nenhum grupo. Peça um convite ao administrador.",
      "NO_ACTIVE_WORKSPACE",
    );
  }
  const detail = blocked
    .map((workspace) => `${workspace.name} (${(WORKSPACE_STATUS_LABELS[workspace.status] ?? workspace.status).toLowerCase()})`)
    .join(", ");
  return new ApiError(
    403,
    "NO_ACTIVE_WORKSPACE",
    `Nenhum dos seus grupos está operando no momento: ${detail}. Fale com o administrador da plataforma.`,
    {
      workspaces: blocked.map((workspace) => ({
        id: workspace.id, name: workspace.name, status: workspace.status, reason: workspace.statusReason,
      })),
    },
  );
}
