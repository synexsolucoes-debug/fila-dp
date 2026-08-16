import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { createRecoveryToken } from "@/lib/fila-dp-recovery";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    requireCapability(workspace, "members.manage");
    const member = await d1.prepare(`SELECT u.id, u.email, u.name
      FROM fdp_workspace_members wm JOIN fdp_users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? AND wm.user_id = ?`).bind(workspace.id, id).first<{ id: string; email: string; name: string }>();
    if (!member) return Response.json({ error: "Membro não encontrado neste workspace." }, { status: 404 });
    const { token, hash } = createRecoveryToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await d1.batch([
      d1.prepare("UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").bind(member.id),
      d1.prepare("INSERT INTO fdp_access_recovery_tokens (id, user_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), member.id, hash, auth.user.email, expiresAt),
    ]);
    await recordActivity(workspace.id, null, auth.user.email, "workspace.recovery_link_created", { email: member.email, expiresAt });
    const recoveryUrl = new URL("/recuperar", request.url);
    recoveryUrl.searchParams.set("token", token);
    recoveryUrl.searchParams.set("email", member.email);
    return Response.json({ snapshot: await getWorkspaceSnapshot(auth.user), recoveryUrl: recoveryUrl.toString(), expiresAt, memberName: member.name });
  } catch (error) {
    return apiError(error);
  }
}
