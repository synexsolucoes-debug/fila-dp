import { ApiError, apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot } from "@/lib/fila-dp-db";
import { OPERATIONAL_WORKSPACE_STATUSES, WORKSPACE_STATUS_LABELS } from "@/lib/workspace-access";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as { workspaceId?: string };
    const workspaceId = text(body.workspaceId, 80);
    const { d1, user } = await getWorkspaceContext(auth.user);
    const membership = await d1.prepare(
      `SELECT w.status, w.status_reason
         FROM fdp_workspace_members wm
         JOIN fdp_workspaces w ON w.id = wm.workspace_id
        WHERE wm.workspace_id = ? AND wm.user_id = ?`,
    )
      .bind(workspaceId, user.id)
      .first<{ status: string | null; status_reason: string | null }>();
    if (!membership) throw ApiError.notFound("Workspace não encontrado.", "WORKSPACE_NOT_FOUND");
    /* Um grupo que não opera não pode virar contexto de trabalho.
       Gravar a preferência mesmo assim deixava o usuário com uma escolha que
       nunca seria honrada: a resolução caía no primeiro grupo operacional e a
       tela anunciava "Workspace alterado" para uma troca que não aconteceu.
       Recusar aqui, dizendo o estado, é o que permite a pessoa entender por que
       o grupo não abre — e é a mesma regra que `resolveActiveWorkspace` aplica. */
    const status = text(membership.status, 40) || "active";
    if (!OPERATIONAL_WORKSPACE_STATUSES.has(status)) {
      const label = (WORKSPACE_STATUS_LABELS[status] ?? status).toLowerCase();
      const reason = text(membership.status_reason, 200);
      throw new ApiError(
        409,
        "WORKSPACE_NOT_OPERATIONAL",
        `Este grupo está ${label} e não pode ser aberto.${reason ? ` Motivo: ${reason}.` : ""} Fale com o administrador da plataforma para reativá-lo.`,
        { workspaceId, status, reason },
      );
    }
    await d1.prepare(
      `INSERT INTO fdp_user_workspace_preferences (user_id, active_workspace_id, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = excluded.active_workspace_id, updated_at = CURRENT_TIMESTAMP`,
    ).bind(user.id, workspaceId).run();
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
