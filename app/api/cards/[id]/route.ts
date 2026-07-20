import { apiError, computeSlaStatus, getApiUser, text, validDate } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    const current = await d1.prepare("SELECT * FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).first<Record<string, unknown>>();
    if (!current) throw new Error("Demanda não encontrada.");

    const title = body.title === undefined ? String(current.title) : text(body.title, 180);
    if (!title) return Response.json({ error: "Informe o título da demanda." }, { status: 400 });
    const assigneeName = body.assigneeName === undefined ? String(current.assignee_name ?? "") : text(body.assigneeName, 120);
    let listId = String(current.list_id);
    let list = await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ?").bind(listId, board.id).first<{ id: string; kind: string; sla_behavior: string }>();
    if (!list) throw new Error("Coluna não encontrada.");

    if (!String(current.assignee_name ?? "") && assigneeName && list.kind === "new") {
      const analysis = await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE board_id = ? AND kind = 'analysis'").bind(board.id).first<{ id: string; kind: string; sla_behavior: string }>();
      if (analysis) {
        list = analysis;
        listId = analysis.id;
      }
    }

    const dueAt = body.dueAt === undefined ? (current.due_at ? String(current.due_at) : null) : validDate(body.dueAt);
    const priority = body.priority === undefined ? String(current.priority) : (["low", "normal", "high", "urgent"].includes(String(body.priority)) ? String(body.priority) : "normal");
    await d1.prepare(`UPDATE fdp_cards SET
      list_id = ?, title = ?, description = ?, company = ?, process_type = ?, priority = ?, assignee_name = ?, due_at = ?, sla_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND board_id = ?`)
      .bind(
        listId,
        title,
        body.description === undefined ? String(current.description ?? "") : text(body.description),
        body.company === undefined ? String(current.company ?? "") : text(body.company, 160),
        body.processType === undefined ? String(current.process_type ?? "OUTROS") : text(body.processType, 40).toUpperCase(),
        priority,
        assigneeName,
        dueAt,
        computeSlaStatus(dueAt, list.sla_behavior),
        id,
        board.id,
      ).run();

    await recordActivity(workspace.id, id, auth.user.email, "card.updated", { title, automationApplied: listId !== current.list_id });
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
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    const result = await d1.prepare("UPDATE fdp_cards SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).run();
    if (!result.meta.changes) throw new Error("Demanda não encontrada.");
    await recordActivity(workspace.id, id, auth.user.email, "card.archived");
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

