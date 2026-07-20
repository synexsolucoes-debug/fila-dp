import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const title = text(body.title, 160);
    const startAt = text(body.startAt, 40);
    const endAt = text(body.endAt, 40);
    const cardId = text(body.cardId, 100) || null;
    if (!title || !startAt || !endAt || new Date(endAt).getTime() <= new Date(startAt).getTime()) return Response.json({ error: "Informe um bloco com título e horário válido." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    if (cardId) {
      const card = await d1.prepare("SELECT id FROM fdp_cards WHERE id = ? AND board_id IN (SELECT id FROM fdp_boards WHERE workspace_id = ?)").bind(cardId, workspace.id).first();
      if (!card) return Response.json({ error: "Demanda não encontrada." }, { status: 404 });
    }
    await d1.prepare("INSERT INTO fdp_planner_blocks (id, workspace_id, user_id, card_id, title, start_at, end_at, block_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), workspace.id, user.id, cardId, title, startAt, endAt, text(body.blockType, 30) || "focus", text(body.notes, 500)).run();
    await recordActivity(workspace.id, cardId, auth.user.email, "planner.block_created", { title, startAt, endAt });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) { return apiError(error); }
}
