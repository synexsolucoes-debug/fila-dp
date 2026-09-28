import { ApiError, apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { requireCapability } from "@/lib/authorization";
import {
  getWorkspaceContext, prepareActivity, prepareAuditEvent, requireCardCompanyAccess,
} from "@/lib/fila-dp-db";

/**
 * Trava a conclusão da tarefa para quem não é o responsável dela (§4, §3.10).
 *
 * Espelha o bloqueio equivalente da etapa (`evaluateStepRequirements`,
 * `lib/process-instances.ts`): `responsibility_mode` sempre foi salvo aqui,
 * mas nada comparava o autor da conclusão contra ele. `INHERIT` continua sem
 * checagem própria — delega para a etapa, que já tem a sua.
 *
 * `DEPARTMENT_MANAGER`, `EMPLOYEE_MANAGER` e `PROCESS_OWNER` comparam contra
 * um id já resolvido por quem chama (mesmo padrão de `evaluateStepRequirements`):
 * sem valor resolvido, a tarefa não trava.
 */
function taskResponsibilityBlocker(input: {
  mode: string;
  responsibleUserId: string | null;
  responsibleAreaId: string | null;
  cardCreatedBy: string;
  actorUserId: string;
  actorEmail: string;
  actorAreaIds: ReadonlySet<string>;
  isAdmin: boolean;
  departmentManagerUserId: string | null;
  employeeManagerUserId: string | null;
  processOwnerUserId: string | null;
}): string | null {
  if (input.isAdmin) return null;
  if (input.mode === "USER" && input.responsibleUserId && input.responsibleUserId !== input.actorUserId) {
    return "Esta tarefa está atribuída a outra pessoa.";
  }
  if (input.mode === "DEPARTMENT" && input.responsibleAreaId && !input.actorAreaIds.has(input.responsibleAreaId)) {
    return "Esta tarefa pertence a outro departamento.";
  }
  if (input.mode === "REQUESTER" && input.cardCreatedBy && input.cardCreatedBy !== input.actorEmail) {
    return "Esta tarefa só pode ser concluída por quem abriu a demanda.";
  }
  if (input.mode === "DEPARTMENT_MANAGER" && input.departmentManagerUserId && input.departmentManagerUserId !== input.actorUserId) {
    return "Esta tarefa só pode ser concluída pelo gestor do departamento responsável.";
  }
  if (input.mode === "EMPLOYEE_MANAGER" && input.employeeManagerUserId && input.employeeManagerUserId !== input.actorUserId) {
    return "Esta tarefa só pode ser concluída pelo gestor do colaborador da demanda.";
  }
  if (input.mode === "PROCESS_OWNER" && input.processOwnerUserId && input.processOwnerUserId !== input.actorUserId) {
    return "Esta tarefa só pode ser concluída pelo responsável designado do processo.";
  }
  return null;
}

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
    const current = await d1.prepare(`SELECT task.*, card.board_id, card.created_by AS card_created_by,
      card.employee_id AS card_employee_id, card.process_definition_id AS card_process_definition_id
      FROM fdp_demand_tasks task
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
    if (status === "completed" && String(current.status) !== "completed") {
      const responsibleAreaId = current.responsible_area_id ? String(current.responsible_area_id) : null;
      const employeeId = current.card_employee_id ? String(current.card_employee_id) : null;
      const processDefinitionId = current.card_process_definition_id ? String(current.card_process_definition_id) : null;
      const [areas, departmentManager, employeeManager, processOwner] = await Promise.all([
        d1.prepare("SELECT area_id FROM fdp_area_members WHERE workspace_id = ? AND user_id = ?")
          .bind(workspace.id, user.id).all<{ area_id: string }>(),
        responsibleAreaId
          ? d1.prepare("SELECT manager_user_id FROM fdp_areas WHERE workspace_id = ? AND id = ?")
            .bind(workspace.id, responsibleAreaId).first<{ manager_user_id: string | null }>()
          : Promise.resolve(null),
        employeeId
          ? d1.prepare(`SELECT wm.user_id FROM fdp_employees e
              JOIN fdp_workspace_members wm ON wm.workspace_id = e.workspace_id AND wm.employee_id = e.manager_employee_id
              WHERE e.workspace_id = ? AND e.id = ?`)
            .bind(workspace.id, employeeId).first<{ user_id: string }>()
          : Promise.resolve(null),
        processDefinitionId
          ? d1.prepare("SELECT owner_user_id FROM fdp_process_definitions WHERE workspace_id = ? AND id = ?")
            .bind(workspace.id, processDefinitionId).first<{ owner_user_id: string | null }>()
          : Promise.resolve(null),
      ]);
      const blocked = taskResponsibilityBlocker({
        mode: String(current.responsibility_mode || "INHERIT"),
        responsibleUserId: current.responsible_user_id ? String(current.responsible_user_id) : null,
        responsibleAreaId,
        cardCreatedBy: String(current.card_created_by || ""),
        actorUserId: user.id,
        actorEmail: auth.user.email,
        actorAreaIds: new Set(areas.results.map((row) => String(row.area_id))),
        isAdmin: workspace.role === "admin",
        departmentManagerUserId: departmentManager?.manager_user_id ?? null,
        employeeManagerUserId: employeeManager?.user_id ?? null,
        processOwnerUserId: processOwner?.owner_user_id ?? null,
      });
      if (blocked) throw new ApiError(403, "TASK_NOT_RESPONSIBLE", blocked);
    }
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
