import { getD1, getScopedD1 } from "../db/index.ts";
import { recordAuthEvent } from "./auth-events.ts";
import { provisionWorkspaceDefaults } from "./fila-dp-db.ts";
import { hashSignupConfirmationToken } from "./signup-security.ts";

type SignupRow = {
  id: string;
  email: string;
  name: string;
  workspace_name: string;
  workspace_slug: string;
  provisioned_user_id: string;
  provisioned_workspace_id: string;
  provisioned_board_id: string;
};

export async function confirmStarterSignup(token: string) {
  if (!/^[A-Za-z0-9_-]{40,80}$/u.test(token)) return false;
  const tokenHash = hashSignupConfirmationToken(token);
  const pending = await getD1().prepare(`SELECT id, email, name, workspace_name, workspace_slug,
      provisioned_user_id, provisioned_workspace_id, provisioned_board_id
    FROM fdp_signup_requests
    WHERE token_hash = ? AND status = 'pending' AND token_expires_at > CURRENT_TIMESTAMP`)
    .bind(tokenHash).first<SignupRow>();
  if (!pending) return false;

  const confirmationNonce = crypto.randomUUID();
  const workspaceId = pending.provisioned_workspace_id;
  const userId = pending.provisioned_user_id;
  const boardId = pending.provisioned_board_id;
  const scoped = getScopedD1({ workspaceId, userId });
  const initial: D1PreparedStatement[] = [
    scoped.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`starter-signup:${pending.id}`),
    scoped.prepare(`UPDATE fdp_signup_requests request SET
        status = 'confirmed', confirmation_nonce = ?, used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE request.id = ? AND request.token_hash = ? AND request.status = 'pending'
        AND request.token_expires_at > CURRENT_TIMESTAMP
        AND NOT EXISTS (SELECT 1 FROM fdp_users user_account WHERE lower(user_account.email) = request.email)
        AND NOT EXISTS (SELECT 1 FROM fdp_starter_owners owner_guard WHERE owner_guard.user_id = request.provisioned_user_id)`)
      .bind(confirmationNonce, pending.id, tokenHash),
    scoped.prepare(`SELECT 1 / CASE WHEN EXISTS (
        SELECT 1 FROM fdp_signup_requests WHERE id = ? AND confirmation_nonce = ? AND status = 'confirmed'
      ) THEN 1 ELSE 0 END AS claimed`).bind(pending.id, confirmationNonce),
    scoped.prepare(`INSERT INTO fdp_users (id, email, name, password_hash, password_salt, email_verified_at)
      SELECT provisioned_user_id, email, name, password_hash, password_salt, CURRENT_TIMESTAMP
      FROM fdp_signup_requests WHERE id = ? AND confirmation_nonce = ?`).bind(pending.id, confirmationNonce),
    scoped.prepare(`INSERT INTO fdp_workspaces (id, name, slug, owner_user_id, contact_email, status)
      SELECT provisioned_workspace_id, workspace_name, workspace_slug, provisioned_user_id, email, 'active'
      FROM fdp_signup_requests WHERE id = ? AND confirmation_nonce = ?`).bind(pending.id, confirmationNonce),
    scoped.prepare("INSERT INTO fdp_starter_owners (user_id, owned_workspace_id) VALUES (?, ?)").bind(userId, workspaceId),
    scoped.prepare(`INSERT INTO fdp_workspace_members (workspace_id, user_id, role)
      SELECT provisioned_workspace_id, provisioned_user_id, 'admin'
      FROM fdp_signup_requests
      WHERE id = ? AND confirmation_nonce = ? AND provisioned_workspace_id = ?`)
      .bind(pending.id, confirmationNonce, workspaceId),
    scoped.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, 'Fila geral', 'Operação central do Departamento Pessoal', 'general')").bind(boardId, workspaceId),
    scoped.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Novas demandas', 'new', 1000, 'running')").bind(crypto.randomUUID(), workspaceId, boardId),
    scoped.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Em análise', 'analysis', 2000, 'running')").bind(crypto.randomUUID(), workspaceId, boardId),
    scoped.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Concluído', 'done', 3000, 'completed')").bind(crypto.randomUUID(), workspaceId, boardId),
    scoped.prepare("INSERT INTO fdp_workspace_onboarding (workspace_id, status, current_step) VALUES (?, 'in_progress', 'company')").bind(workspaceId),
    scoped.prepare(`INSERT INTO fdp_workspace_subscriptions
        (id, workspace_id, plan_id, plan_price_id, contracted_monthly_price_cents,
         contracted_price_cents, contracted_currency, status, billing_interval, seat_quantity, provider)
      SELECT ?, ?, plan.id, price.id, price.monthly_price_cents,
        price.monthly_price_cents, price.currency, 'active', 'monthly', price.included_seats, 'manual'
      FROM fdp_saas_plans plan
      JOIN LATERAL (SELECT id, monthly_price_cents, currency, included_seats
        FROM fdp_saas_plan_prices WHERE plan_id = plan.id ORDER BY effective_from DESC LIMIT 1) price ON true
      WHERE plan.code = 'starter' AND plan.status = 'active'`)
      .bind(crypto.randomUUID(), workspaceId),
    scoped.prepare(`INSERT INTO fdp_user_workspace_preferences (user_id, active_workspace_id, active_board_id)
      VALUES (?, ?, ?)`).bind(userId, workspaceId, boardId),
    scoped.prepare(`INSERT INTO fdp_audit_events
        (id, workspace_id, actor_type, actor_user_id, actor_email, action, outcome, entity_type, entity_id,
         before_json, after_json, metadata_json, request_id)
      VALUES (?, ?, 'user', ?, ?, 'workspace.self_signup_confirmed', 'success', 'workspace', ?,
        '{}'::jsonb, ?::jsonb, ?::jsonb, '')`)
      .bind(crypto.randomUUID(), workspaceId, userId, pending.email, workspaceId,
        JSON.stringify({ planCode: "starter", workspaceName: pending.workspace_name }),
        JSON.stringify({ signupRequestId: pending.id })),
    scoped.prepare(`SELECT 1 / CASE WHEN EXISTS (
        SELECT 1 FROM fdp_workspace_subscriptions WHERE workspace_id = ? AND status = 'active'
      ) THEN 1 ELSE 0 END AS provisioned`).bind(workspaceId),
  ];

  try {
    await provisionWorkspaceDefaults(scoped, workspaceId, initial);
  } catch (error) {
    const code = String((error as { code?: unknown })?.code ?? "");
    if (code === "22012" || code === "23505" || /division by zero|duplicate key/iu.test(String(error))) return false;
    throw error;
  }
  await recordAuthEvent({ action: "signup_confirmed", outcome: "success", email: pending.email, userId, reason: "workspace Starter ativado" });
  return true;
}
