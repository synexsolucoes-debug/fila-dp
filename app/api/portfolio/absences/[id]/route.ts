import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

/** Cancelar uma ausência lançada por engano; a remoção fica na auditoria. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "cancelar ausências da equipe");
    const absence = await d1.prepare("SELECT user_id, starts_on::text AS starts_on, ends_on::text AS ends_on FROM fdp_member_absences WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ user_id: string; starts_on: string; ends_on: string }>();
    if (!absence) throw ApiError.notFound("Ausência não encontrada.", "ABSENCE_NOT_FOUND");
    await d1.batch([
      d1.prepare("DELETE FROM fdp_member_absences WHERE workspace_id = ? AND id = ?").bind(workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "member_absence.deleted", entityType: "member_absence", entityId: id,
        before: { userId: absence.user_id, startsOn: absence.starts_on, endsOn: absence.ends_on },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ deleted: true });
  } catch (error) { return apiError(error); }
}
