import { ApiError, apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { requireCapability } from "@/lib/authorization";
import {
  getWorkspaceContext, prepareActivity, prepareAuditEvent, requireCardCompanyAccess,
} from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };
const taskStatuses = new Set(["pending", "in_progress", "completed", "skipped", "cancelled"]);

export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "cards.write");
    const current = await d1.prepare(`SELECT task.*, card.board_id FROM fdp_demand_tasks task
      JOIN fdp_cards card ON card.workspace_id = task.workspace_id AND card.id = task.card_id
      WHERE task.workspace_id = ? AND task.id = ? AND card.board_id = ? AND card.archived = 0`)
      .bind(workspace.id, id, board.id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Tarefa não encontrada.", "TASK_NOT_FOUND");
    const cardId = String(current.card_id);
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, cardId);
    const expectedVersion = Number(body.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw ApiError.badRequest("Informe a versão atual da tarefa.", "TASK_VERSION_REQUIRED");
    }
    const status = text(body.status, 30) || String(current.status);
    if (!taskStatuses.has(status)) throw ApiError.badRequest("Status de tarefa inválido.", "TASK_STATUS_INVALID");
    if (status === "completed" && Number(current.evidence_required) === 1) {
      const evidence = await d1.prepare(`SELECT COUNT(*)::int AS total FROM fdp_card_attachments
        WHERE workspace_id = ? AND card_id = ? AND task_instance_id = ?`)
        .bind(workspace.id, cardId, id).first<{ total: number }>();
      if (!Number(evidence?.total ?? 0)) {
        throw new ApiError(422, "TASK_EVIDENCE_REQUIRED", "Anexe uma evidência a esta tarefa antes de concluí-la.");
      }
    }
    const responsibleUserId = body.responsibleUserId === undefined ? current.responsible_user_id : text(body.responsibleUserId, 120) || null;
    const responsibleAreaId = body.responsibleAreaId === undefined ? current.responsible_area_id : text(body.responsibleAreaId, 120) || null;
    const responsibilityMode = body.responsibilityMode === undefined ? String(current.responsibility_mode) : text(body.responsibilityMode, 40) || "INHERIT";
    const dueAt = body.dueAt === undefined ? current.due_at : text(body.dueAt, 40) || null;
    if (dueAt && Number.isNaN(Date.parse(String(dueAt)))) throw ApiError.badRequest("Prazo inválido.", "TASK_DUE_AT_INVALID");
    const completionNote = body.completionNote === undefined ? String(current.completion_note ?? "") : text(body.completionNote, 2000);
    const updated = await d1.prepare(`UPDATE fdp_demand_tasks SET status = ?, responsibility_mode = ?,
        responsible_user_id = ?, responsible_area_id = ?, due_at = ?, completion_note = ?,
        started_at = CASE WHEN ? = 'in_progress' THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
        completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
        completed_by = CASE WHEN ? = 'completed' THEN ? ELSE NULL END, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND version = ? RETURNING id, version`)
      .bind(status, responsibilityMode, responsibleUserId, responsibleAreaId, dueAt, completionNote,
        status, status, status, user.id, workspace.id, id, expectedVersion)
      .first<{ id: string; version: number }>();
    if (!updated) throw new ApiError(409, "TASK_VERSION_CONFLICT", "Esta tarefa foi alterada por outra pessoa. Recarregue antes de tentar novamente.");
    await d1.batch([
      d1.prepare(`UPDATE fdp_checklist_items SET completed = ?, completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE workspace_id = ? AND task_instance_id = ?`)
        .bind(status === "completed" ? 1 : 0, status === "completed" ? 1 : 0, workspace.id, id),
      prepareActivity(workspace.id, cardId, auth.user.email, "process.task_updated", { taskId: id, status }),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "process.task_updated", entityType: "process_task", entityId: id,
        before: { status: current.status, responsibleUserId: current.responsible_user_id, responsibleAreaId: current.responsible_area_id, version: expectedVersion },
        after: { status, responsibleUserId, responsibleAreaId, version: updated.version },
        metadata: { completionNote }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ task: { id, status, version: updated.version } });
  } catch (error) {
    return apiError(error);
  }
}
