import { ApiError, apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const title = text(body.title, 180);
    if (!title) return Response.json({ error: "Informe a etapa do checklist." }, { status: 400 });
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const card = await d1.prepare("SELECT id FROM fdp_cards WHERE id = ? AND board_id = ? AND archived = 0").bind(id, board.id).first();
    if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
    const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_checklist_items WHERE card_id = ?").bind(id).first<{ max_position: number }>();
    await d1.prepare("INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position) VALUES (?, ?, ?, ?, 0, ?)")
      .bind(crypto.randomUUID(), workspace.id, id, title, Number(position?.max_position ?? 0) + 1000)
      .run();
    await recordActivity(workspace.id, id, auth.user.email, "checklist.item_added", { title });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

