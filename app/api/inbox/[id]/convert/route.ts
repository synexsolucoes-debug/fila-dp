import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const item = await d1.prepare("SELECT * FROM fdp_workspace_inbox_items WHERE id = ? AND workspace_id = ? AND status = 'new'").bind(id, workspace.id).first<Record<string, unknown>>();
    if (!item) throw new Error("Solicitação não encontrada ou já convertida.");
    const list = await d1.prepare("SELECT id FROM fdp_lists WHERE board_id = ? AND kind = 'new'").bind(board.id).first<{ id: string }>();
    if (!list) throw new Error("Coluna inicial não encontrada.");
    const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0").bind(list.id).first<{ max_position: number }>();
    const cardId = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_cards
        (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 'OUTROS', 'normal', '', 'safe', ?, ?, ?)`)
        .bind(cardId, board.id, list.id, String(item.subject), String(item.body ?? ""), String(item.sender_name), Number(position?.max_position ?? 0) + 1000, String(item.channel), auth.user.email),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Analisar solicitação', 0, 1000)").bind(crypto.randomUUID(), cardId),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Executar atividade', 0, 2000)").bind(crypto.randomUUID(), cardId),
      d1.prepare("UPDATE fdp_workspace_inbox_items SET status = 'converted', converted_card_id = ? WHERE id = ? AND workspace_id = ?").bind(cardId, id, workspace.id),
    ]);
    await recordActivity(workspace.id, cardId, auth.user.email, "inbox.item_converted", { inboxItemId: id });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

