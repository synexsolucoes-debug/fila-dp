import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { ensureProcessVersion, publishProcessVersion } from "@/lib/fila-dp-processes";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const current = await d1.prepare(`SELECT l.board_id, l.name, l.position, l.sla_behavior
      FROM fdp_lists l
      JOIN fdp_boards b ON b.id = l.board_id
      WHERE l.id = ? AND b.workspace_id = ?`)
      .bind(id, workspace.id)
      .first<{ board_id: string; name: string; position: number; sla_behavior: string }>();
    if (!current) return Response.json({ error: "Coluna não encontrada." }, { status: 404 });
    await ensureProcessVersion(d1, current.board_id, auth.user.email);

    const name = body.name === undefined ? current.name : text(body.name, 80);
    if (!name) return Response.json({ error: "Informe o nome da coluna." }, { status: 400 });
    const candidatePosition = Number(body.position);
    const position = Number.isFinite(candidatePosition) ? candidatePosition : current.position;
    const slaBehavior = ["running", "paused", "completed"].includes(String(body.slaBehavior)) ? String(body.slaBehavior) : current.sla_behavior;
    const scope = " AND board_id IN (SELECT id FROM fdp_boards WHERE workspace_id = ?)";
    await d1.prepare(`UPDATE fdp_lists SET name = ?, position = ?, sla_behavior = ? WHERE id = ?${scope}`)
      .bind(name, position, slaBehavior, id, workspace.id)
      .run();
    const processVersion = await publishProcessVersion(d1, current.board_id, auth.user.email);
    await recordActivity(workspace.id, null, auth.user.email, "list.updated", {
      listId: id,
      boardId: current.board_id,
      changes: {
        name: current.name === name ? undefined : { from: current.name, to: name },
        slaBehavior: current.sla_behavior === slaBehavior ? undefined : { from: current.sla_behavior, to: slaBehavior },
        position: current.position === position ? undefined : { from: current.position, to: position },
      },
      processVersion,
    });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const current = await d1.prepare(`SELECT l.board_id, l.name
      FROM fdp_lists l
      JOIN fdp_boards b ON b.id = l.board_id
      WHERE l.id = ? AND b.workspace_id = ?`)
      .bind(id, workspace.id)
      .first<{ board_id: string; name: string }>();
    if (!current) return Response.json({ error: "Coluna não encontrada." }, { status: 404 });
    await ensureProcessVersion(d1, current.board_id, auth.user.email);
    const count = await d1.prepare("SELECT COUNT(*) AS value FROM fdp_lists WHERE board_id = ?").bind(current.board_id).first<{ value: number }>();
    if (Number(count?.value ?? 0) <= 1) return Response.json({ error: "O quadro precisa manter pelo menos uma coluna." }, { status: 400 });

    const cards = await d1.prepare("SELECT COUNT(*) AS value FROM fdp_cards WHERE list_id = ?").bind(id).first<{ value: number }>();
    const cardCount = Number(cards?.value ?? 0);
    let moveToListId = "";
    if (cardCount > 0) {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      moveToListId = text(body.moveToListId, 100);
      if (!moveToListId) return Response.json({ error: "Escolha a coluna que receberá as demandas antes de excluir esta coluna." }, { status: 400 });
      const destination = await d1.prepare("SELECT id, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ? AND id <> ?")
        .bind(moveToListId, current.board_id, id)
        .first<{ id: string; sla_behavior: string }>();
      if (!destination) return Response.json({ error: "A coluna de destino não é válida." }, { status: 400 });
      const nextPosition = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM fdp_cards WHERE list_id = ?").bind(destination.id).first<{ value: number }>();
      await d1.prepare("UPDATE fdp_cards SET list_id = ?, position = position + ?, sla_status = CASE WHEN ? = 'paused' THEN 'paused' WHEN ? = 'completed' THEN 'completed' WHEN sla_status IN ('paused', 'completed') THEN 'safe' ELSE sla_status END, updated_at = CURRENT_TIMESTAMP WHERE list_id = ?")
        .bind(destination.id, Number(nextPosition?.value ?? 0) + 1000, destination.sla_behavior, destination.sla_behavior, id)
        .run();
    }

    const deleted = await d1.prepare("DELETE FROM fdp_lists WHERE id = ? AND board_id IN (SELECT id FROM fdp_boards WHERE workspace_id = ?)").bind(id, workspace.id).run();
    if (Number(deleted.meta.changes ?? 0) === 0) return Response.json({ error: "Coluna não encontrada." }, { status: 404 });
    const processVersion = await publishProcessVersion(d1, current.board_id, auth.user.email);
    await recordActivity(workspace.id, null, auth.user.email, "list.deleted", { listId: id, name: current.name, movedCards: cardCount, moveToListId: moveToListId || null, processVersion });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
