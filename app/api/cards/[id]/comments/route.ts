import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { body?: string };
    const comment = text(body.body, 2000);
    if (!comment) return Response.json({ error: "Escreva um comentário." }, { status: 400 });
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member", "guest"]);
    const card = await d1.prepare("SELECT id FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0")
      .bind(id, board.id)
      .first();
    if (!card) throw new Error("Demanda não encontrada.");
    await d1.prepare("INSERT INTO fdp_card_comments (id, card_id, author_user_id, body) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), id, user.id, comment)
      .run();
    await recordActivity(workspace.id, id, auth.user.email, "card.commented");
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
