import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { enabled?: boolean };
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const result = await d1.prepare("UPDATE fdp_automation_rules SET enabled = ? WHERE id = ? AND workspace_id = ?")
      .bind(body.enabled ? 1 : 0, id, workspace.id)
      .run();
    if (!result.meta.changes) throw new Error("Regra não encontrada.");
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

