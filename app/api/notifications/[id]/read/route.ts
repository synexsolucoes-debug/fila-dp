import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const result = await d1.prepare("UPDATE fdp_notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ? AND user_id = ?").bind(id, workspace.id, user.id).run();
    if (!result.meta.changes) throw new Error("Notificação não encontrada.");
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
