/**
 * Ciclo de vida do grupo: arquivar, restaurar e excluir.
 *
 * Duas decisões estruturam este módulo.
 *
 * **A exclusão pedida pelo cliente é reversível.** Ela leva o grupo ao estado
 * `deleted` e marca a data a partir da qual a remoção física pode acontecer.
 * Dentro do prazo, um administrador restaura. Passado o prazo, o console da
 * plataforma remove de verdade (`/api/platform/workspaces/[id]/delete`, que já
 * existia e continua sendo o único caminho destrutivo). Exclusão imediata e
 * irreversível a um clique é a operação que mais gera chamado de recuperação —
 * e a recuperação, sem este passo, não existe.
 *
 * **Um grupo fora de operação não pode trancar o usuário para fora do produto.**
 * O estado vive no grupo, nunca na conta. Quem participa de outros grupos
 * continua entrando normalmente; `resolveActiveWorkspace` escolhe outro contexto
 * (ver `lib/workspace-access.ts`). Por isso nada aqui toca sessão ou usuário.
 */
import { ApiError } from "./api-errors.ts";

export type WorkspaceLifecycleAction = "archive" | "restore" | "delete";

export type WorkspaceLifecycleState = {
  id: string;
  name: string;
  slug: string;
  status: string;
  deletedAt: string | null;
  purgeAfter: string | null;
};

/** Prazo padrão de recuperação de um grupo excluído. */
export const DEFAULT_PURGE_DAYS = 30;

/** Prazo configurável por deployment, dentro de limites que fazem sentido. */
export function purgeRetentionDays(raw: string | undefined = process.env.FDP_WORKSPACE_PURGE_DAYS) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PURGE_DAYS;
  return Math.max(1, Math.min(365, Math.trunc(parsed)));
}

/** Data-limite para restaurar, a partir do instante da exclusão. */
export function purgeDeadline(from: Date, days = purgeRetentionDays()) {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * O que a exclusão do grupo atinge, para ser mostrado antes da confirmação.
 *
 * A lista é fixa e escrita em português de produto porque ela é texto de
 * interface: o usuário precisa reconhecer nela o próprio trabalho, não nomes de
 * tabela.
 */
export const WORKSPACE_DELETION_IMPACT = [
  "usuários vinculados ao grupo",
  "demandas e quadros",
  "integrações, credenciais e automações",
  "empresas cadastradas",
  "colaboradores",
  "documentos e anexos",
  "histórico operacional e trilha de auditoria",
] as const;

/** A permissão exigida por ação — o backend decide, nunca o botão da tela. */
export const LIFECYCLE_CAPABILITY = {
  archive: "workspace.archive",
  restore: "workspace.restore",
  delete: "workspace.delete",
} as const;

/** Frase da ação, usada na mensagem de recusa por falta de permissão. */
export const LIFECYCLE_ACTION_LABEL = {
  archive: "arquivar este grupo",
  restore: "restaurar este grupo",
  delete: "excluir este grupo",
} as const;

export function parseLifecycleAction(value: unknown): WorkspaceLifecycleAction {
  const action = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (action !== "archive" && action !== "restore" && action !== "delete") {
    throw ApiError.badRequest("Ação de ciclo de vida inválida. Use archive, restore ou delete.", "WORKSPACE_ACTION_INVALID");
  }
  return action;
}

/**
 * Decide se a transição é permitida a partir do estado atual.
 *
 * Estados de origem válidos por ação, e o motivo de cada recusa ser específica:
 * uma recusa genérica manda o usuário adivinhar se o problema é permissão,
 * estado ou prazo — três causas com três soluções diferentes.
 */
export function assertLifecycleTransition(
  workspace: WorkspaceLifecycleState,
  action: WorkspaceLifecycleAction,
  now: Date = new Date(),
) {
  const { status, name } = workspace;

  if (action === "archive") {
    if (status === "archived") {
      throw new ApiError(409, "WORKSPACE_ALREADY_ARCHIVED", `"${name}" já está arquivado.`);
    }
    if (status === "deleted") {
      throw new ApiError(409, "WORKSPACE_DELETED", `"${name}" está excluído. Restaure o grupo antes de arquivá-lo.`);
    }
    return;
  }

  if (action === "restore") {
    if (status === "active") {
      throw new ApiError(409, "WORKSPACE_ALREADY_ACTIVE", `"${name}" já está ativo.`);
    }
    if (status === "deleted") {
      // Passado o prazo, restaurar deixa de ser uma promessa que o produto pode
      // cumprir: os dados podem já ter sido removidos pelo expurgo.
      const deadline = workspace.purgeAfter ? new Date(workspace.purgeAfter) : null;
      if (deadline && !Number.isNaN(deadline.getTime()) && now > deadline) {
        throw new ApiError(409, "WORKSPACE_PURGE_WINDOW_EXPIRED",
          `O prazo de recuperação de "${name}" terminou em ${deadline.toLocaleDateString("pt-BR")}. `
          + "A restauração precisa ser tratada pelo administrador da plataforma.");
      }
    }
    if (status === "suspended" || status === "canceled") {
      // Suspensão é decisão comercial da plataforma; devolver o grupo ao ar por
      // aqui contornaria a cobrança.
      throw new ApiError(409, "WORKSPACE_STATUS_NOT_RESTORABLE",
        `"${name}" está ${status === "suspended" ? "suspenso" : "cancelado"} por decisão administrativa. `
        + "Fale com o administrador da plataforma.");
    }
    return;
  }

  if (status === "deleted") {
    throw new ApiError(409, "WORKSPACE_ALREADY_DELETED", `"${name}" já está excluído.`);
  }
}

/**
 * Confere a confirmação forte da exclusão.
 *
 * Digitar o identificador do grupo é o que impede o clique cair no grupo errado
 * quando a pessoa administra vários — o risco real aqui não é o clique acidental
 * num grupo só, é confundir dois grupos parecidos.
 */
export function assertDeletionConfirmation(workspace: WorkspaceLifecycleState, body: Record<string, unknown>) {
  if (body.confirmed !== true) {
    throw ApiError.badRequest(
      "Confirme explicitamente a exclusão do grupo.",
      "WORKSPACE_CONFIRMATION_REQUIRED",
    );
  }
  const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
  if (confirmation !== workspace.slug) {
    throw ApiError.badRequest(
      `Para confirmar a exclusão de "${workspace.name}", digite exatamente o identificador do grupo: ${workspace.slug}`,
      "WORKSPACE_CONFIRMATION_MISMATCH",
    );
  }
}

/**
 * Motivo do arquivamento ou da exclusão; fica no registro e na auditoria.
 *
 * O mínimo de 5 caracteres para arquivar não é preciosismo: o banco tem um
 * CHECK (`fdp_workspaces_status_reason_check`) exigindo motivo em todo estado
 * que não seja `active`. Sem validar aqui, o UPDATE violaria a constraint e o
 * usuário receberia um 500 genérico — justamente o "Não foi possível concluir a
 * operação" que este trabalho existe para eliminar. Validar antes transforma
 * isso numa mensagem que diz o que fazer.
 *
 * Restaurar não pede motivo porque o estado resultante é `active`, que o CHECK
 * não cobre.
 */
export function lifecycleReason(value: unknown, action: WorkspaceLifecycleAction) {
  const reason = typeof value === "string" ? value.trim().slice(0, 500) : "";
  if (action === "delete" && reason.length < 10) {
    throw ApiError.badRequest(
      "Explique o motivo da exclusão. Ele fica registrado e é o que explica a operação depois.",
      "WORKSPACE_DELETE_REASON_REQUIRED",
    );
  }
  if (action === "archive" && reason.length < 5) {
    throw ApiError.badRequest(
      "Informe o motivo do arquivamento (ao menos 5 caracteres). Ele aparece para quem tentar usar o grupo depois.",
      "WORKSPACE_ARCHIVE_REASON_REQUIRED",
    );
  }
  return reason;
}

/** Estado resultante da ação, pronto para virar UPDATE. */
export function nextLifecycleState(action: WorkspaceLifecycleAction, now: Date = new Date()) {
  if (action === "archive") return { status: "archived", deletedAt: null, purgeAfter: null };
  if (action === "restore") return { status: "active", deletedAt: null, purgeAfter: null };
  return {
    status: "deleted",
    deletedAt: now.toISOString(),
    purgeAfter: purgeDeadline(now).toISOString(),
  };
}
