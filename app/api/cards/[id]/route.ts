import { ApiError, apiError, computeSlaStatus, getApiUser, text, validDueAt, validProcessType } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireCompanyAccess, requireWorkspaceRole, runAutomations } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { replaceCardRelations } from "@/lib/fila-dp-relations";
import { validCompetence } from "@/lib/operations";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");
    const current = await d1.prepare("SELECT * FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");

    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const title = body.title === undefined ? String(current.title) : text(body.title, 180);
    if (!title) return Response.json({ error: "Informe o título da demanda." }, { status: 400 });
    const assigneeName = body.assigneeName === undefined ? String(current.assignee_name ?? "") : text(body.assigneeName, 120);
    const hasNewAssignees = Array.isArray(body.assigneeIds) && body.assigneeIds.length > 0;
    const companyId = body.companyId === undefined ? (current.company_id ? String(current.company_id) : null) : (text(body.companyId, 120) || null);
    let companyName = body.company === undefined ? String(current.company ?? "") : text(body.company, 160);
    if (companyId) {
      const company = await d1.prepare("SELECT legal_name, trade_name FROM fdp_companies WHERE id = ? AND workspace_id = ? AND status = 'active'").bind(companyId, workspace.id).first<{ legal_name: string; trade_name: string }>();
      if (!company) return Response.json({ error: "Empresa selecionada não encontrada." }, { status: 400 });
      companyName = company.trade_name || company.legal_name;
    }
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const listId = String(current.list_id);
    const list = await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ?").bind(listId, board.id).first<{ id: string; kind: string; sla_behavior: string }>();
    if (!list) throw ApiError.notFound("Coluna não encontrada.", "LIST_NOT_FOUND");

    const dueAt = body.dueAt === undefined ? (current.due_at ? String(current.due_at) : null) : validDueAt(body.dueAt);
    const priority = body.priority === undefined ? String(current.priority) : (["low", "normal", "high", "urgent"].includes(String(body.priority)) ? String(body.priority) : "normal");
    const nextDescription = body.description === undefined ? String(current.description ?? "") : text(body.description);
    const nextProcessType = body.processType === undefined ? String(current.process_type ?? "OUTROS") : validProcessType(body.processType);
    const competence = body.competence === undefined ? String(current.competence ?? "") : (body.competence ? validCompetence(body.competence) : "");
    const legalDueAt = body.legalDueAt === undefined ? (current.legal_due_at ? String(current.legal_due_at) : null) : validDueAt(body.legalDueAt);
    const processTemplateId = body.templateId === undefined ? (current.process_template_id ? String(current.process_template_id) : null) : (text(body.templateId, 120) || null);
    if (processTemplateId && !await d1.prepare("SELECT id FROM fdp_process_templates WHERE workspace_id = ? AND id = ? AND active = 1").bind(workspace.id, processTemplateId).first()) throw ApiError.badRequest("Template inválido.", "INVALID_PROCESS_TEMPLATE");
    await d1.prepare(`UPDATE fdp_cards SET
      list_id = ?, title = ?, description = ?, company_id = ?, company = ?, process_type = ?, priority = ?, assignee_name = ?, due_at = ?, sla_status = ?, competence = ?, legal_due_at = ?, process_template_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND board_id = ?`)
      .bind(
        listId,
        title,
        nextDescription,
        companyId,
        companyName,
        nextProcessType,
        priority,
        assigneeName,
        dueAt,
        computeSlaStatus(dueAt, list.sla_behavior),
        competence,
        legalDueAt,
        processTemplateId,
        id,
        board.id,
      ).run();

    await replaceCardRelations(d1, workspace.id, id, body);
    if (hasNewAssignees) await runAutomations(workspace.id, board.id, id, "assignee.added", auth.user.email, { assignee: "present" });

    const changes = Object.fromEntries(Object.entries({
      title: [String(current.title ?? ""), title],
      description: [String(current.description ?? ""), nextDescription],
      company: [String(current.company ?? ""), companyName],
      processType: [String(current.process_type ?? ""), nextProcessType],
      priority: [String(current.priority ?? ""), priority],
      assigneeName: [String(current.assignee_name ?? ""), assigneeName],
      dueAt: [current.due_at ? String(current.due_at) : "", dueAt ?? ""],
      competence: [String(current.competence ?? ""), competence],
      legalDueAt: [current.legal_due_at ? String(current.legal_due_at) : "", legalDueAt ?? ""],
    }).filter(([, [from, to]]) => from !== to).map(([field, [from, to]]) => [field, { from, to }]));
    await recordActivity(workspace.id, id, auth.user.email, "card.updated", { title, changes, automationApplied: listId !== current.list_id });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const result = await d1.prepare("UPDATE fdp_cards SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).run();
    if (!result.meta.changes) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
    await recordActivity(workspace.id, id, auth.user.email, "card.archived");
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

