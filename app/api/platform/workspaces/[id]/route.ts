import { getD1, getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";
import { requiredPlatformReason } from "@/lib/platform-console";

type Params = { params: Promise<{ id: string }> };

const workspaceStatuses = ["active", "suspended", "canceled", "archived"] as const;

/**
 * Administra um workspace: situação, plano, limites e propriedade.
 *
 * Suspender, cancelar e arquivar exigem motivo — o banco repete a exigência em
 * CHECK. Nada aqui apaga dados do cliente: arquivar é estado, não exclusão.
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    if (body.confirmed !== true) throw ApiError.badRequest("Confirme explicitamente a ação administrativa.", "PLATFORM_CONFIRMATION_REQUIRED");
    const reason = requiredPlatformReason(body.reason);

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const before = await d1.prepare(`SELECT w.id, w.name, w.status, w.status_reason, w.owner_user_id,
          s.plan_id, s.seat_quantity, s.status AS subscription_status
        FROM fdp_workspaces w LEFT JOIN fdp_workspace_subscriptions s ON s.workspace_id = w.id
        WHERE w.id = ?`).bind(id).first<Record<string, unknown>>();
      if (!before) throw ApiError.notFound("Workspace não encontrado.", "WORKSPACE_NOT_FOUND");
      const scoped = getPlatformScopedD1({ workspaceId: id, userId: platform.userId });

      const statements = [];
      const after: Record<string, unknown> = {};

      if (body.status !== undefined) {
        const status = cleanText(body.status, 20);
        if (!(workspaceStatuses as readonly string[]).includes(status)) {
          throw ApiError.badRequest("Situação de workspace inválida.", "INVALID_WORKSPACE_STATUS");
        }
        if (status !== "active" && reason.length < 5) {
          throw ApiError.badRequest("Informe o motivo com pelo menos 5 caracteres para suspender, cancelar ou arquivar.", "STATUS_REASON_REQUIRED");
        }
        statements.push(d1.prepare("UPDATE fdp_workspaces SET status = ?, status_reason = ?, status_changed_at = now() WHERE id = ?")
          .bind(status, status === "active" ? "" : reason, id));
        after.status = status;
        after.reason = status === "active" ? "" : reason;
      }

      if (body.planCode !== undefined) {
        const plan = await d1.prepare("SELECT id, code, included_seats FROM fdp_saas_plans WHERE code = ? AND status <> 'archived'")
          .bind(cleanText(body.planCode, 40)).first<{ id: string; code: string; included_seats: number }>();
        if (!plan) throw ApiError.badRequest("Plano inválido.", "INVALID_PLAN");
        // Downgrade com mais usuários que o novo limite é recusado: reduzir o
        // plano nunca pode significar apagar usuário do cliente.
        const seats = await scoped.prepare("SELECT count(*)::int AS used FROM fdp_workspace_members WHERE workspace_id = ?")
          .bind(id).first<{ used: number }>();
        const requested = Number(body.seatQuantity ?? plan.included_seats);
        const limit = Math.max(requested, Number(plan.included_seats));
        if (Number(seats?.used ?? 0) > limit) {
          throw new ApiError(409, "PLAN_DOWNGRADE_BLOCKED",
            `O workspace tem ${seats?.used} usuário(s) e o plano ${plan.code} comporta ${limit}. Remova usuários antes de reduzir o plano.`,
            { seatsUsed: Number(seats?.used ?? 0), seatLimit: limit });
        }
        statements.push(d1.prepare(`UPDATE fdp_workspace_subscriptions SET plan_id = ?, seat_quantity = ?,
            plan_price_id = (SELECT id FROM fdp_saas_plan_prices WHERE plan_id = ? ORDER BY effective_from DESC LIMIT 1),
            contracted_monthly_price_cents = (SELECT monthly_price_cents FROM fdp_saas_plan_prices WHERE plan_id = ? ORDER BY effective_from DESC LIMIT 1),
            updated_at = now() WHERE workspace_id = ?`)
          .bind(plan.id, limit, plan.id, plan.id, id));
        after.planCode = plan.code;
        after.seatQuantity = limit;
      }

      if (body.ownerEmail !== undefined) {
        const email = cleanText(body.ownerEmail, 180).toLowerCase();
        const owner = await d1.prepare("SELECT id, status FROM fdp_users WHERE email = ?").bind(email).first<{ id: string; status: string }>();
        if (!owner) throw ApiError.badRequest("O novo proprietário precisa ter conta antes da transferência.", "OWNER_NOT_FOUND");
        if (owner.status === "blocked") throw ApiError.badRequest("Usuário bloqueado não pode ser proprietário.", "OWNER_BLOCKED");
        statements.push(
          d1.prepare("UPDATE fdp_workspaces SET owner_user_id = ? WHERE id = ?").bind(owner.id, id),
          // Transferir propriedade sem garantir o papel deixaria o dono sem acesso.
          d1.prepare("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin') ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'admin'")
            .bind(id, owner.id),
        );
        after.ownerEmail = email;
      }

      if (!statements.length) throw ApiError.badRequest("Nada para alterar.", "EMPTY_UPDATE");
      after.reason = reason;

      statements.push(d1.prepare(`INSERT INTO fdp_platform_audit_events
          (id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, request_id)
        VALUES (?, ?, ?, 'platform.workspace_updated', 'workspace', ?, ?::jsonb, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), platform.userId, platform.email, id,
          JSON.stringify(before), JSON.stringify(after), request.headers.get("x-fila-dp-request-id") ?? ""));

      await scoped.batch(statements);
      return Response.json({ workspace: { id, ...after } });
    });
  } catch (error) { return apiError(error); }
}
