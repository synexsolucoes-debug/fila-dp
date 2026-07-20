import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const name = text(body.name, 80);
    const boardId = text(body.boardId, 100);
    const kind = text(body.kind, 50).toLowerCase().replace(/[^a-z0-9-]/g, "-") || `custom-${crypto.randomUUID().slice(0, 8)}`;
    const slaBehavior = ["running", "paused", "completed"].includes(String(body.slaBehavior)) ? String(body.slaBehavior) : "running";
    if (!name || !boardId) return Response.json({ error: "Informe o quadro e o nome da coluna." }, { status: 400 });
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const board = await d1.prepare("SELECT id FROM fdp_boards WHERE id = ? AND workspace_id = ?").bind(boardId, workspace.id).first();
    if (!board) return Response.json({ error: "Quadro não encontrado." }, { status: 404 });
    const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM fdp_lists WHERE board_id = ?").bind(boardId).first<{ value: number }>();
    await d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), boardId, name, `${kind}-${crypto.randomUUID().slice(0, 6)}`, Number(position?.value ?? 0) + 1000, slaBehavior).run();
    await recordActivity(workspace.id, null, auth.user.email, "list.created", { boardId, name });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
