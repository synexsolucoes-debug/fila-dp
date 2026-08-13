import { getD1, getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { hashPassword } from "@/app/chatgpt-auth";
import { provisionWorkspaceDefaults } from "@/lib/fila-dp-db";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";
import { workspaceSlug } from "@/lib/saas";
import { decodePlatformCursor, encodePlatformCursor, platformListLimit, requiredPlatformReason } from "@/lib/platform-console";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lista os workspaces do SaaS com plano, assinatura e consumo de assentos. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const url = new URL(request.url);
    const status = cleanText(url.searchParams.get("status"), 20);
    const query = cleanText(url.searchParams.get("q"), 120).toLowerCase();
    const limit = platformListLimit(url.searchParams.get("limit"));
    const cursor = decodePlatformCursor(url.searchParams.get("cursor"));

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const filters = ["1 = 1"];
      const values: unknown[] = [];
      if (status) { filters.push("w.status = ?"); values.push(status); }
      if (query) { filters.push("(lower(w.name) LIKE ? OR lower(w.slug) LIKE ? OR w.tax_id LIKE ?)"); values.push(`%${query}%`, `%${query}%`, `%${query}%`); }
      if (cursor) { filters.push("(w.created_at < ?::timestamptz OR (w.created_at = ?::timestamptz AND w.id < ?))"); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }

      const rows = await d1.prepare(`SELECT w.id, w.name, w.slug, w.status, w.status_reason, w.legal_name, w.tax_id,
          w.contact_email, w.timezone, w.created_at, u.email AS owner_email, u.name AS owner_name,
          s.status AS subscription_status, s.billing_interval, s.seat_quantity, s.current_period_ends_at,
          p.code AS plan_code, p.name AS plan_name, p.included_seats
        FROM fdp_workspaces w
        JOIN fdp_users u ON u.id = w.owner_user_id
        LEFT JOIN fdp_workspace_subscriptions s ON s.workspace_id = w.id
        LEFT JOIN fdp_saas_plans p ON p.id = s.plan_id
        WHERE ${filters.join(" AND ")} ORDER BY w.created_at DESC, w.id DESC LIMIT ?`)
        .bind(...values, limit + 1).all<Record<string, unknown>>();
      const workspaces: Record<string, unknown>[] = await Promise.all(rows.results.slice(0, limit).map(async (workspace): Promise<Record<string, unknown>> => {
        const workspaceId = String(workspace.id);
        const scoped = getPlatformScopedD1({ workspaceId, userId: platform.userId });
        const usage = await scoped.prepare(`SELECT
            (SELECT count(*)::int FROM fdp_workspace_members WHERE workspace_id = ?) AS seats_used,
            (SELECT count(*)::int FROM fdp_companies WHERE workspace_id = ?) AS companies`)
          .bind(workspaceId, workspaceId).first<Record<string, unknown>>();
        return { ...workspace, seats_used: Number(usage?.seats_used ?? 0), companies: Number(usage?.companies ?? 0) };
      }));
      const next = rows.results.length > limit ? workspaces.at(-1) : null;
      return Response.json({ workspaces, nextCursor: encodePlatformCursor(next ? { createdAt: String(next.created_at), id: String(next.id) } : null) }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}

/**
 * Cria um workspace pela administração da plataforma.
 *
 * Tudo em uma transação: usuário proprietário, workspace, vínculo de
 * administrador, assinatura, quadro e padrões. Uma falha no meio não pode
 * deixar workspace sem dono nem dono sem workspace.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const body = await request.json() as Record<string, unknown>;
    if (body.confirmed !== true) throw ApiError.badRequest("Confirme explicitamente a criação do workspace.", "PLATFORM_CONFIRMATION_REQUIRED");
    const reason = requiredPlatformReason(body.reason);
    const name = cleanText(body.name, 120);
    const ownerEmail = cleanText(body.ownerEmail, 180).toLowerCase();
    const ownerName = cleanText(body.ownerName, 160) || ownerEmail.split("@")[0] || "Proprietário";
    const planCode = cleanText(body.planCode, 40) || "starter";
    if (name.length < 2) throw ApiError.badRequest("Informe o nome do workspace.", "WORKSPACE_NAME_REQUIRED");
    if (!/^\S+@\S+\.\S+$/u.test(ownerEmail)) throw ApiError.badRequest("Informe o e-mail do proprietário.", "OWNER_EMAIL_REQUIRED");

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const plan = await d1.prepare("SELECT id, code, included_seats FROM fdp_saas_plans WHERE code = ? AND status <> 'archived'")
        .bind(planCode).first<{ id: string; code: string; included_seats: number }>();
      if (!plan) throw ApiError.badRequest("Plano inválido para contratação.", "INVALID_PLAN");

      const slugBase = cleanText(body.slug, 60) || workspaceSlug(name);
      const taken = await d1.prepare("SELECT id FROM fdp_workspaces WHERE slug = ?").bind(slugBase).first();
      if (taken) throw new ApiError(409, "WORKSPACE_SLUG_CONFLICT", `Já existe um workspace com o identificador "${slugBase}".`);

      const existingOwner = await d1.prepare("SELECT id, status FROM fdp_users WHERE email = ?")
        .bind(ownerEmail).first<{ id: string; status: string }>();
      if (existingOwner?.status === "blocked") {
        throw new ApiError(409, "OWNER_BLOCKED", "O usuário informado está bloqueado. Desbloqueie antes de torná-lo proprietário.");
      }

      const ownerId = existingOwner?.id ?? crypto.randomUUID();
      const workspaceId = crypto.randomUUID();
      const boardId = crypto.randomUUID();
      // Provisionar escreve em tabelas do cliente: a transação carrega o tenant
      // do workspace que está nascendo, além da marca de plataforma.
      const tenant = getPlatformScopedD1({ workspaceId, userId: platform.userId });
      const statements = [];
      if (!existingOwner) {
        // Sem senha definida: o proprietário entra pelo fluxo de recuperação de
        // acesso. Nunca criamos senha padrão nem senha em texto aberto.
        const placeholder = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
        statements.push(tenant.prepare("INSERT INTO fdp_users (id, email, name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)")
          .bind(ownerId, ownerEmail, ownerName, placeholder.hash, placeholder.salt));
      }
      statements.push(
        tenant.prepare(`INSERT INTO fdp_workspaces (id, name, slug, owner_user_id, legal_name, tax_id, contact_email)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(workspaceId, name, slugBase, ownerId, cleanText(body.legalName, 200), cleanText(body.taxId, 20), cleanText(body.contactEmail, 180) || ownerEmail),
        tenant.prepare("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')").bind(workspaceId, ownerId),
        tenant.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, 'Fila geral', 'Operação central do Departamento Pessoal', 'general')").bind(boardId, workspaceId),
        tenant.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Novas demandas', 'new', 1000, 'running')").bind(crypto.randomUUID(), workspaceId, boardId),
        tenant.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Em análise', 'analysis', 2000, 'running')").bind(crypto.randomUUID(), workspaceId, boardId),
        tenant.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, 'Concluído', 'done', 3000, 'completed')").bind(crypto.randomUUID(), workspaceId, boardId),
        tenant.prepare("INSERT INTO fdp_workspace_onboarding (workspace_id, status, current_step) VALUES (?, 'in_progress', 'company')").bind(workspaceId),
        tenant.prepare(`INSERT INTO fdp_workspace_subscriptions (id, workspace_id, plan_id, plan_price_id, contracted_monthly_price_cents, status, billing_interval, seat_quantity, provider)
          SELECT ?, ?, ?, pr.id, pr.monthly_price_cents, 'active', 'monthly', ?, 'manual'
          FROM fdp_saas_plan_prices pr WHERE pr.plan_id = ? ORDER BY pr.effective_from DESC LIMIT 1`)
          .bind(crypto.randomUUID(), workspaceId, plan.id, Number(plan.included_seats), plan.id),
        tenant.prepare(`INSERT INTO fdp_platform_audit_events (id, actor_user_id, actor_email, action, entity_type, entity_id, after_json, request_id)
          VALUES (?, ?, ?, 'platform.workspace_created', 'workspace', ?, ?::jsonb, ?)`)
          .bind(crypto.randomUUID(), platform.userId, platform.email, workspaceId,
            JSON.stringify({ name, slug: slugBase, planCode: plan.code, ownerEmail, reason }), request.headers.get("x-fila-dp-request-id") ?? ""),
      );

      await provisionWorkspaceDefaults(tenant, workspaceId, statements);
      return Response.json({
        workspace: { id: workspaceId, name, slug: slugBase, planCode: plan.code, ownerEmail, ownerCreated: !existingOwner },
      }, { status: 201 });
    });
  } catch (error) { return apiError(error); }
}
