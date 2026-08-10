import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { createRecoveryToken } from "@/lib/fila-dp-recovery";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { ApiError } from "@/lib/api-errors";

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

    const currentMembership = await d1.prepare("SELECT 1 AS member FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = (SELECT id FROM fdp_users WHERE email = ?)")
      .bind(workspace.id, email).first<{ member: number }>();
    if (!currentMembership) {
      const allowance = await d1.prepare(`SELECT GREATEST(subscription.seat_quantity, plan.included_seats)::integer AS seat_limit,
          plan.name AS plan_name,
          (SELECT COUNT(*)::integer FROM fdp_workspace_members WHERE workspace_id = ?) AS used
        FROM fdp_workspace_subscriptions subscription JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id
        WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')`)
        .bind(workspace.id, workspace.id).first<{ seat_limit: number; used: number; plan_name: string }>();
      if (!allowance) {
        throw new ApiError(409, "SUBSCRIPTION_INACTIVE", "Este grupo não possui assinatura ativa. Fale com o administrador da plataforma para reativar o acesso.");
      }
      if (Number(allowance.used) >= Number(allowance.seat_limit)) {
        // A mensagem diz o plano, o uso e o limite: "atingiu o limite" sozinho
        // não permite ao administrador decidir o que fazer.
        throw new ApiError(409, "PLAN_SEAT_LIMIT",
          `O plano ${allowance.plan_name} permite ${allowance.seat_limit} usuário(s) e ${allowance.used} já estão em uso. Remova um usuário ou solicite a mudança de plano.`,
          { planName: String(allowance.plan_name), seatLimit: Number(allowance.seat_limit), seatsUsed: Number(allowance.used) });
      }
    }

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

    const membership = await d1.prepare(`WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext(?))
      ), entitlement AS (
        SELECT GREATEST(subscription.seat_quantity, plan.included_seats)::integer AS seat_limit
        FROM fdp_workspace_subscriptions subscription JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
        WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
      )
      INSERT INTO fdp_workspace_members (workspace_id, user_id, role)
      SELECT ?, ?, ? FROM entitlement
      WHERE EXISTS (SELECT 1 FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?)
         OR (SELECT COUNT(*) FROM fdp_workspace_members WHERE workspace_id = ?) < entitlement.seat_limit
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role
      RETURNING user_id`)
      .bind(workspace.id, workspace.id, workspace.id, invitedUser.id, role, workspace.id, invitedUser.id, workspace.id)
      .first<{ user_id: string }>();
    if (!membership) throw new ApiError(409, "PLAN_SEAT_LIMIT", "O plano atual atingiu o limite de usuários. Remova um usuário ou solicite a mudança de plano.");

    await d1.batch([
      d1.prepare("DELETE FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ?").bind(workspace.id, invitedUser.id),
      ...companyIds.map((companyId) => d1.prepare("INSERT INTO fdp_member_company_access (workspace_id, user_id, company_id) VALUES (?, ?, ?)").bind(workspace.id, invitedUser!.id, companyId)),
    ]);

    let activation: { url: string; expiresAt: string; name: string } | null = null;
    if (createdNow || !invitedUser.password_hash) {
      const { token, hash } = createRecoveryToken();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await d1.batch([
        d1.prepare("UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").bind(invitedUser.id),
        d1.prepare("INSERT INTO fdp_access_recovery_tokens (id, user_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), invitedUser.id, hash, auth.user.email, expiresAt),
      ]);
      const url = new URL("/recuperar", request.url);
      url.searchParams.set("token", token);
      url.searchParams.set("email", email);
      activation = { url: url.toString(), expiresAt, name };
    }

    await recordActivity(workspace.id, null, auth.user.email, "workspace.member_added", { email, role, companyIds, createdNow });
    return Response.json({ snapshot: await getWorkspaceSnapshot(auth.user), activation }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
