import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { ensureProcessVersion, publishProcessVersion } from "@/lib/fila-dp-processes";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { enabled?: boolean };
    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    await ensureProcessVersion(d1, board.id, auth.user.email);
    const result = await d1.prepare("UPDATE fdp_automation_rules SET enabled = ? WHERE id = ? AND workspace_id = ? AND board_id = ?")
      .bind(body.enabled ? 1 : 0, id, workspace.id, board.id)
      .run();
    if (!result.meta.changes) throw new Error("Regra não encontrada.");
    const processVersion = await publishProcessVersion(d1, board.id, auth.user.email);
    await recordActivity(workspace.id, null, auth.user.email, "automation.toggled", { ruleId: id, enabled: Boolean(body.enabled), boardId: board.id, processVersion });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

