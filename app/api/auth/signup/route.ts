import { hashPassword, setAuthSession } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { checkLoginRateLimit, clearLoginIdentityFailures, clientAddress, recordLoginFailure } from "@/lib/auth-rate-limit";
import { provisionWorkspaceDefaults, prepareAuditEvent } from "@/lib/fila-dp-db";
import { selfSignupEnabled, workspaceSlug } from "@/lib/saas";
import { setTenantContext } from "@/lib/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SignupBody = { email?: string; password?: string; name?: string; groupName?: string };

export async function POST(request: Request) {
  if (!selfSignupEnabled()) {
    return Response.json({ error: "A criação pública de contas não está habilitada." }, { status: 403 });
  }
  try {
    if (process.env.NODE_ENV === "production" && !process.env.FDP_AUTH_SECRET) {
      return Response.json({ error: "A autenticação do site não está configurada." }, { status: 503 });
    }
    const body = await request.json() as SignupBody;
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const name = String(body.name ?? "").trim().slice(0, 160);
    const groupName = String(body.groupName ?? "").trim().slice(0, 60);
    if (!/^\S+@\S+\.\S+$/u.test(email)) return Response.json({ error: "Informe um e-mail válido." }, { status: 400 });
    if (password.length < 8 || password.length > 200) return Response.json({ error: "A senha deve ter entre 8 e 200 caracteres." }, { status: 400 });
    if (name.length < 2 || groupName.length < 2) return Response.json({ error: "Informe seu nome e o nome do grupo." }, { status: 400 });

    const address = clientAddress(request);
    const rateLimit = await checkLoginRateLimit(email, address);
    if (!rateLimit.allowed) {
      return Response.json({ error: "Muitas tentativas. Aguarde alguns minutos." }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
    }

    const d1 = getD1();
    const existing = await d1.prepare("SELECT id FROM fdp_users WHERE email = ?").bind(email).first<{ id: string }>();
    if (existing) {
      await recordLoginFailure(email, address);
      return Response.json({ error: "Este e-mail já está vinculado a uma conta. Entre com sua senha ou use a recuperação de acesso." }, { status: 409 });
    }

    const credentials = await hashPassword(password);
    const userId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const boardId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    setTenantContext({ workspaceId, userId });

    const userStatement = d1.prepare("INSERT INTO fdp_users (id, email, name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, email, name, credentials.hash, credentials.salt);

    await provisionWorkspaceDefaults(d1, workspaceId, [
      userStatement,
      d1.prepare("INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)").bind(workspaceId, groupName, workspaceSlug(groupName), userId),
      d1.prepare("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')").bind(workspaceId, userId),
      d1.prepare("INSERT INTO fdp_user_workspace_preferences (user_id, active_workspace_id, active_board_id, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = EXCLUDED.active_workspace_id, active_board_id = EXCLUDED.active_board_id, updated_at = CURRENT_TIMESTAMP").bind(userId, workspaceId, boardId),
      d1.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, 'Fila geral', 'Operação central do Departamento Pessoal', 'general')").bind(boardId, workspaceId),
      d1.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Novas demandas', 'new', 1000, 'running')").bind(crypto.randomUUID(), workspaceId, boardId),
      d1.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Em análise', 'analysis', 2000, 'running')").bind(crypto.randomUUID(), workspaceId, boardId),
      d1.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Concluído', 'done', 3000, 'completed')").bind(crypto.randomUUID(), workspaceId, boardId),
      d1.prepare("INSERT INTO fdp_workspace_onboarding (workspace_id, status, current_step) VALUES (?, 'in_progress', 'company')").bind(workspaceId),
      d1.prepare("INSERT INTO fdp_workspace_subscriptions (id, workspace_id, plan_id, status, billing_interval, seat_quantity, provider) VALUES (?, ?, 'plan_starter', 'active', 'monthly', 1, 'manual')").bind(subscriptionId, workspaceId),
      prepareAuditEvent({ workspaceId, actorUserId: userId, actorEmail: email, action: "saas.workspace_provisioned", entityType: "workspace", entityId: workspaceId, after: { planCode: "starter", onboarding: "in_progress" } }),
    ]);

    await clearLoginIdentityFailures(email, address);
    await setAuthSession({ id: userId, email, displayName: name, fullName: name }, { address, userAgent: request.headers.get("user-agent") ?? "" });
    return Response.json({ ok: true, redirectTo: "/painel?onboarding=1" }, { status: 201 });
  } catch (error) {
    console.error("Vinculato signup failed", error);
    return Response.json({ error: "Não foi possível criar a conta. Verifique os dados e tente novamente." }, { status: 500 });
  }
}
