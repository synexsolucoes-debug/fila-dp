import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { createRecoveryToken } from "@/lib/fila-dp-recovery";
import { sendTransactionalEmail, type EmailDeliveryResult } from "@/lib/fila-dp-email";
import type { WorkspaceRole } from "@/lib/fila-dp-types";

const memberRoles: WorkspaceRole[] = ["admin", "member", "observer", "guest"];

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;

  try {
    const body = await request.json() as Record<string, unknown>;
    const email = text(body.email, 180).toLowerCase();
    const name = text(body.name, 120) || email.split("@")[0] || "Novo usuário";
    const role = String(body.role ?? "member") as WorkspaceRole;
    const companyIds = Array.isArray(body.companyIds) ? [...new Set(body.companyIds.map((id) => text(id, 120)).filter(Boolean))] : [];
    if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Informe um e-mail válido." }, { status: 400 });
    if (!memberRoles.includes(role)) return Response.json({ error: "Papel de acesso inválido." }, { status: 400 });

    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);

    let invitedUser = await d1.prepare("SELECT id, password_hash FROM fdp_users WHERE email = ?").bind(email).first<{ id: string; password_hash: string | null }>();
    const createdNow = !invitedUser;
    if (!invitedUser) {
      const userId = crypto.randomUUID();
      await d1.prepare("INSERT INTO fdp_users (id, email, name) VALUES (?, ?, ?)").bind(userId, email, name).run();
      invitedUser = { id: userId, password_hash: null };
    }

    const owner = await d1.prepare("SELECT owner_user_id FROM fdp_workspaces WHERE id = ?").bind(workspace.id).first<{ owner_user_id: string }>();
    if (owner?.owner_user_id === invitedUser.id && role !== "admin") return Response.json({ error: "O proprietário precisa permanecer administrador." }, { status: 400 });

    const validCompanies = companyIds.length
      ? await d1.prepare(`SELECT id FROM fdp_companies WHERE workspace_id = ? AND id IN (${companyIds.map(() => "?").join(",")})`).bind(workspace.id, ...companyIds).all<{ id: string }>()
      : { results: [] as { id: string }[] };
    if (validCompanies.results.length !== companyIds.length) return Response.json({ error: "Uma ou mais empresas selecionadas não pertencem a este grupo." }, { status: 400 });

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_workspace_members (workspace_id, user_id, role)
        VALUES (?, ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`).bind(workspace.id, invitedUser.id, role),
      d1.prepare("DELETE FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ?").bind(workspace.id, invitedUser.id),
      ...companyIds.map((companyId) => d1.prepare("INSERT INTO fdp_member_company_access (workspace_id, user_id, company_id) VALUES (?, ?, ?)").bind(workspace.id, invitedUser!.id, companyId)),
    ]);

    let activation: { url: string; expiresAt: string; name: string; delivery: EmailDeliveryResult["status"] } | null = null;
    if (createdNow || !invitedUser.password_hash) {
      const { token, hash } = createRecoveryToken();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await d1.batch([
        d1.prepare("UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").bind(invitedUser.id),
        d1.prepare("INSERT INTO fdp_access_recovery_tokens (id, user_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), invitedUser.id, hash, auth.user.email, expiresAt),
      ]);
      const url = new URL("/recuperar", process.env.FDP_PUBLIC_URL || request.url);
      url.searchParams.set("token", token);
      url.searchParams.set("email", email);
      const delivery = await sendTransactionalEmail({
        to: email,
        subject: `Seu acesso ao ${workspace.name} no Fila DP`,
        preheader: "Defina sua senha e acesse as demandas liberadas para você.",
        title: `Olá, ${name}.`,
        paragraphs: [`Você recebeu acesso ao grupo ${workspace.name} com o papel de ${role}.`, "O link expira em 30 minutos e só pode ser utilizado uma vez."],
        actionLabel: "Ativar meu acesso",
        actionUrl: url.toString(),
        idempotencyKey: `workspace-invite-${workspace.id}-${invitedUser.id}-${hash.slice(0, 16)}`,
      });
      if (delivery.status === "failed") console.error("[fila-dp][email] workspace-invite", { workspaceId: workspace.id, email, error: delivery.error });
      activation = { url: url.toString(), expiresAt, name, delivery: delivery.status };
    }

    await recordActivity(workspace.id, null, auth.user.email, "workspace.member_added", { email, role, companyIds, createdNow });
    return Response.json({ snapshot: await getWorkspaceSnapshot(auth.user), activation }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
