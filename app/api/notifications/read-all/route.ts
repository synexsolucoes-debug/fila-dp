import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot } from "@/lib/fila-dp-db";

export async function POST() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    await d1.prepare("UPDATE fdp_notifications SET read_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL").bind(workspace.id, user.id).run();
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
