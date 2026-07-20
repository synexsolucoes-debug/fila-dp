import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot } from "@/lib/fila-dp-db";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as { workspaceId?: string };
    const workspaceId = text(body.workspaceId, 80);
    const { d1, user } = await getWorkspaceContext(auth.user);
    const membership = await d1.prepare("SELECT 1 FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?")
      .bind(workspaceId, user.id)
      .first();
    if (!membership) throw new Error("Workspace não encontrado.");
    await d1.prepare(
      `INSERT INTO fdp_user_workspace_preferences (user_id, active_workspace_id, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = excluded.active_workspace_id, updated_at = CURRENT_TIMESTAMP`,
    ).bind(user.id, workspaceId).run();
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
