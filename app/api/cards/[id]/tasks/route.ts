import { ApiError, apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { requireCapability } from "@/lib/authorization";
import {
  getWorkspaceContext, prepareActivity, prepareAuditEvent, requireCardCompanyAccess,
} from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

async function cardContext(cardId: string) {
  const auth = await getApiUser();
  if (!auth.user) return { response: auth.response } as const;
  const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
  requireCapability(workspace, "cards.read");
  await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, cardId);
  const card = await d1.prepare(`SELECT id, process_version_id, current_step_id FROM fdp_cards
    WHERE workspace_id = ? AND board_id = ? AND id = ? AND archived = 0`)
    .bind(workspace.id, board.id, cardId)
    .first<{ id: string; process_version_id: string | null; current_step_id: string }>();
  if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
  return { auth, d1, workspace, user, card } as const;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const context = await cardContext(id);
    if ("response" in context) return context.response;
    const rows = await context.d1.prepare(`SELECT task.id, task.stage_instance_id, task.bpmn_element_id,
        stage.title AS stage_title, task.title, task.instructions, task.status, task.responsibility_mode,
        task.responsible_user_id, task.responsible_area_id, task.started_at, task.due_at,
        task.completed_at, task.completed_by, task.completion_note, task.evidence_required,
        task.position, task.version
      FROM fdp_demand_tasks task
      JOIN fdp_demand_stages stage ON stage.workspace_id = task.workspace_id AND stage.id = task.stage_instance_id
      WHERE task.workspace_id = ? AND task.card_id = ? ORDER BY stage.position, task.position, task.id`)
      .bind(context.workspace.id, id).all<Record<string, unknown>>();
    return Response.json({ tasks: rows.results });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const context = await cardContext(id);
    if ("response" in context) return context.response;
    const { d1, workspace, user, auth, card } = context;
    requireCapability(workspace, "cards.write");
    if (!card.process_version_id || !card.current_step_id) {
      throw ApiError.badRequest("Tarefas de etapa só podem ser criadas em demandas iniciadas por processo.", "TASK_REQUIRES_PROCESS");
    }
    const title = text(body.title, 180);
    if (!title) throw ApiError.badRequest("Informe o título da tarefa.", "TASK_TITLE_REQUIRED");
    const stage = await d1.prepare(`SELECT id FROM fdp_demand_stages
      WHERE workspace_id = ? AND card_id = ? AND bpmn_element_id = ? AND status = 'in_progress'`)
      .bind(workspace.id, id, card.current_step_id).first<{ id: string }>();
    if (!stage) throw new ApiError(409, "ACTIVE_STAGE_NOT_FOUND", "A etapa atual ainda não foi materializada. Atualize a demanda e tente novamente.");
    const positionRow = await d1.prepare(`SELECT COALESCE(MAX(position), 0) + 1000 AS position
      FROM fdp_demand_tasks WHERE workspace_id = ? AND stage_instance_id = ?`)
      .bind(workspace.id, stage.id).first<{ position: number }>();
    const taskId = crypto.randomUUID();
    const responsibilityMode = text(body.responsibilityMode, 40) || "INHERIT";
    const responsibleUserId = text(body.responsibleUserId, 120) || null;
    const responsibleAreaId = text(body.responsibleAreaId, 120) || null;
    const evidenceRequired = Boolean(body.evidenceRequired);
    const position = Number(positionRow?.position ?? 1000);
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_demand_tasks
        (id, workspace_id, card_id, stage_instance_id, process_version_id, bpmn_element_id,
         title, instructions, status, responsibility_mode, responsible_user_id, responsible_area_id,
         started_at, evidence_required, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`)
        .bind(taskId, workspace.id, id, stage.id, card.process_version_id, card.current_step_id,
          title, text(body.instructions, 4000), responsibilityMode, responsibleUserId, responsibleAreaId,
          evidenceRequired ? 1 : 0, position),
      d1.prepare(`INSERT INTO fdp_checklist_items
        (id, workspace_id, card_id, task_instance_id, title, completed, position, process_step_id)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, taskId, title, position, card.current_step_id),
      prepareActivity(workspace.id, id, auth.user.email, "process.task_created", { taskId, title, adHoc: true }),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "process.task_created", entityType: "process_task", entityId: taskId,
        after: { cardId: id, title, responsibilityMode, responsibleUserId, responsibleAreaId, evidenceRequired },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ task: { id: taskId, title, status: "in_progress", position, version: 1 } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
