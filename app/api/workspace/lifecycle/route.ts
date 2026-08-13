import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { log } from "@/lib/observability";
import {
  assertDeletionConfirmation,
  assertLifecycleTransition,
  LIFECYCLE_ACTION_LABEL,
  LIFECYCLE_CAPABILITY,
  lifecycleReason,
  nextLifecycleState,
  parseLifecycleAction,
  purgeRetentionDays,
  WORKSPACE_DELETION_IMPACT,
  type WorkspaceLifecycleState,
} from "@/lib/workspace-lifecycle";

export const dynamic = "force-dynamic";

/**
 * Arquivar, restaurar e excluir o grupo em que a sessão está.
 *
 * O grupo alvo é **sempre** o da sessão, resolvido no servidor por
 * `getWorkspaceContext`. Não existe parâmetro de workspace nesta rota de
 * propósito: aceitar um id do cliente criaria exatamente o IDOR que o resto do
 * produto evita — bastaria trocar o identificador no corpo para arquivar o grupo
 * de outra empresa.
 *
 * Para operar sobre outro grupo existe o console da plataforma, que exige
 * administrador de plataforma e registra em trilha separada.
 */

function stateOf(row: Record<string, unknown>): WorkspaceLifecycleState {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    slug: String(row.slug ?? ""),
    status: String(row.status ?? "active"),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    purgeAfter: row.purge_after ? String(row.purge_after) : null,
  };
}

/** O que a tela precisa para montar a confirmação — e o que o usuário pode fazer. */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    const row = await d1.prepare(
      "SELECT id, name, slug, status, status_reason, deleted_at, purge_after FROM fdp_workspaces WHERE id = ?",
    ).bind(workspace.id).first<Record<string, unknown>>();
    const current = stateOf(row ?? { id: workspace.id, name: workspace.name, status: workspace.status });

    return Response.json({
      workspace: {
        id: current.id,
        name: current.name,
        slug: current.slug,
        status: current.status,
        deletedAt: current.deletedAt,
        purgeAfter: current.purgeAfter,
      },
      // A tela mostra o botão a partir daqui, mas a decisão continua sendo
      // tomada de novo no POST: esconder o botão é conveniência, não segurança.
      permissions: {
        archive: hasCapability(workspace, "workspace.archive"),
        restore: hasCapability(workspace, "workspace.restore"),
        delete: hasCapability(workspace, "workspace.delete"),
        update: hasCapability(workspace, "workspace.update"),
        membersManage: hasCapability(workspace, "workspace.members.manage"),
        integrationsManage: hasCapability(workspace, "workspace.integrations.manage"),
      },
      deletion: {
        confirmationPhrase: current.slug,
        retentionDays: purgeRetentionDays(),
        impact: WORKSPACE_DELETION_IMPACT,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = parseLifecycleAction(body.action);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);

    // Autorização antes de qualquer leitura de estado: negar acesso não deve
    // depender de o grupo estar num estado ou noutro.
    const capability = LIFECYCLE_CAPABILITY[action];
    if (!hasCapability(workspace, capability)) {
      // Tentativa sem permissão é evento de segurança, não ruído: é o sinal de
      // que alguém está mexendo onde não deve, ou de que a tela ofereceu algo
      // que o backend nega.
      log("warn", "workspace.lifecycle_denied", { workspaceId: workspace.id, userId: user.id }, {
        action, capability, role: workspace.role,
      });
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: `workspace.${action}`, outcome: "denied", entityType: "workspace", entityId: workspace.id,
        metadata: { capability, role: workspace.role },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      requireNamedCapability(workspace, capability, LIFECYCLE_ACTION_LABEL[action]);
    }

    const row = await d1.prepare(
      "SELECT id, name, slug, status, deleted_at, purge_after FROM fdp_workspaces WHERE id = ?",
    ).bind(workspace.id).first<Record<string, unknown>>();
    if (!row) return apiError(new Error("workspace missing"));
    const current = stateOf(row);

    assertLifecycleTransition(current, action);
    if (action === "delete") assertDeletionConfirmation(current, body);
    const reason = lifecycleReason(body.reason, action);
    const next = nextLifecycleState(action);

    await d1.prepare(
      `UPDATE fdp_workspaces
          SET status = ?, status_reason = ?, status_changed_at = CURRENT_TIMESTAMP,
              deleted_at = ?, deleted_by_email = ?, purge_after = ?
        WHERE id = ?`,
    ).bind(
      next.status,
      reason,
      next.deletedAt,
      action === "delete" ? auth.user.email : "",
      next.purgeAfter,
      workspace.id,
    ).run();

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `workspace.${action}`, entityType: "workspace", entityId: workspace.id,
      before: { status: current.status },
      after: { status: next.status, purgeAfter: next.purgeAfter },
      metadata: { reason, capability },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    log("info", `workspace.${action}d`, { workspaceId: workspace.id, userId: user.id }, {
      previousStatus: current.status, status: next.status, purgeAfter: next.purgeAfter,
    });

    const message = action === "archive"
      ? `"${current.name}" foi arquivado. Os dados continuam guardados e o grupo pode ser restaurado a qualquer momento.`
      : action === "restore"
        ? `"${current.name}" foi restaurado e voltou a operar.`
        : `"${current.name}" foi excluído. O grupo pode ser restaurado por um administrador em até ${purgeRetentionDays()} dias; depois disso a remoção passa a ser definitiva.`;

    return Response.json({
      workspace: { id: current.id, name: current.name, slug: current.slug, status: next.status, purgeAfter: next.purgeAfter },
      message,
    });
  } catch (error) {
    return apiError(error);
  }
}
