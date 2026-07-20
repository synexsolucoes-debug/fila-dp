import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import type { WorkspaceRole } from "@/lib/fila-dp-types";

const memberRoles: WorkspaceRole[] = ["admin", "member", "observer", "guest"];

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;

  try {
    const body = await request.json() as Record<string, unknown>;
    const email = text(body.email, 180).toLowerCase();
    const name = text(body.name, 120) || email.split("@")[0] || "Novo membro";
    const role = String(body.role ?? "member") as WorkspaceRole;
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return Response.json({ error: "Informe um e-mail válido." }, { status: 400 });
    }
    if (!memberRoles.includes(role)) {
      return Response.json({ error: "Papel de acesso inválido." }, { status: 400 });
    }

    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);

    let invitedUser = await d1.prepare("SELECT id FROM fdp_users WHERE email = ?")
      .bind(email)
      .first<{ id: string }>();
    if (!invitedUser) {
      const userId = crypto.randomUUID();
      await d1.prepare("INSERT INTO fdp_users (id, email, name) VALUES (?, ?, ?)")
        .bind(userId, email, name)
        .run();
      invitedUser = { id: userId };
    }

    const owner = await d1.prepare("SELECT owner_user_id FROM fdp_workspaces WHERE id = ?")
      .bind(workspace.id)
      .first<{ owner_user_id: string }>();
    if (owner?.owner_user_id === invitedUser.id && role !== "admin") {
      return Response.json({ error: "O proprietário precisa permanecer administrador." }, { status: 400 });
    }

    await d1.prepare(
      `INSERT INTO fdp_workspace_members (workspace_id, user_id, role)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
    ).bind(workspace.id, invitedUser.id, role).run();
    await recordActivity(workspace.id, null, auth.user.email, "workspace.member_added", { email, role });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
