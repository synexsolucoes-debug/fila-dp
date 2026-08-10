import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";

type Params = { params: Promise<{ id: string }> };

/**
 * Detalhe de um workspace para a administração da plataforma.
 *
 * O console listava workspaces mas não abria nenhum: para decidir se suspende,
 * troca de plano ou transfere propriedade era preciso adivinhar quem está lá
 * dentro e o que já aconteceu. Aqui vêm membros, empresas, assinatura e a
 * trilha de auditoria do próprio workspace.
 *
 * Não devolve dado operacional do cliente (demandas, documentos, competências):
 * administrar o contrato não é motivo para ler a operação alheia.
 */
export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id } = await params;

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const workspace = await d1.prepare(`SELECT w.id, w.name, w.slug, w.status, w.status_reason, w.status_changed_at,
          w.legal_name, w.tax_id, w.contact_email, w.created_at, w.owner_user_id,
          owner.email AS owner_email, owner.name AS owner_name,
          s.status AS subscription_status, s.billing_interval, s.seat_quantity, s.provider,
          s.trial_ends_at, s.current_period_ends_at, s.contracted_monthly_price_cents,
          p.code AS plan_code, p.name AS plan_name, p.included_seats, p.company_limit,
          p.integration_limit, p.storage_limit_mb
        FROM fdp_workspaces w
        LEFT JOIN fdp_users owner ON owner.id = w.owner_user_id
        LEFT JOIN fdp_workspace_subscriptions s ON s.workspace_id = w.id
        LEFT JOIN fdp_saas_plans p ON p.id = s.plan_id
        WHERE w.id = ?`).bind(id).first<Record<string, unknown>>();
      if (!workspace) throw ApiError.notFound("Workspace não encontrado.", "WORKSPACE_NOT_FOUND");

      const [members, companies, audit, modules] = await Promise.all([
        d1.prepare(`SELECT wm.user_id, u.email, u.name, wm.role, wm.joined_at, u.status,
            (w.owner_user_id = wm.user_id) AS is_owner,
            (u.password_hash IS NOT NULL) AS is_activated,
            (SELECT max(s.last_seen_at) FROM fdp_auth_sessions s WHERE s.user_id = wm.user_id) AS last_seen_at
          FROM fdp_workspace_members wm
          JOIN fdp_users u ON u.id = wm.user_id
          JOIN fdp_workspaces w ON w.id = wm.workspace_id
          WHERE wm.workspace_id = ?
          ORDER BY (w.owner_user_id = wm.user_id) DESC, u.name`).bind(id).all<Record<string, unknown>>(),
        d1.prepare("SELECT id, legal_name, trade_name, tax_id, is_principal, status FROM fdp_companies WHERE workspace_id = ? ORDER BY is_principal DESC, legal_name")
          .bind(id).all<Record<string, unknown>>(),
        d1.prepare(`SELECT id, actor_email, action, entity_type, entity_id, after_json, created_at
          FROM fdp_platform_audit_events
          WHERE entity_id = ? OR (entity_type = 'workspace' AND entity_id = ?)
          ORDER BY created_at DESC LIMIT 50`).bind(id, id).all<Record<string, unknown>>(),
        d1.prepare(`SELECT m.key, m.name, m.category, (g.granted IS NOT NULL AND g.granted = 1) AS granted_override,
            (pm.module_key IS NOT NULL) AS in_plan
          FROM fdp_modules m
          LEFT JOIN fdp_plan_modules pm ON pm.module_key = m.key
            AND pm.plan_id = (SELECT plan_id FROM fdp_workspace_subscriptions WHERE workspace_id = ?)
          LEFT JOIN fdp_workspace_module_grants g ON g.module_key = m.key AND g.workspace_id = ?
          ORDER BY m.position`).bind(id, id).all<Record<string, unknown>>(),
      ]);

      const truthy = (value: unknown) => value === true || value === 1 || value === "t" || value === "true";
      const text = (value: unknown) => (value == null ? "" : String(value));

      return Response.json({
        workspace: {
          id: text(workspace.id), name: text(workspace.name), slug: text(workspace.slug),
          status: text(workspace.status) || "active", statusReason: text(workspace.status_reason),
          statusChangedAt: workspace.status_changed_at ? text(workspace.status_changed_at) : null,
          legalName: text(workspace.legal_name), taxId: text(workspace.tax_id),
          contactEmail: text(workspace.contact_email), createdAt: text(workspace.created_at),
          owner: { id: text(workspace.owner_user_id), email: text(workspace.owner_email), name: text(workspace.owner_name) },
          subscription: {
            status: text(workspace.subscription_status) || "none",
            billingInterval: text(workspace.billing_interval),
            provider: text(workspace.provider),
            seatQuantity: Number(workspace.seat_quantity ?? 0),
            trialEndsAt: workspace.trial_ends_at ? text(workspace.trial_ends_at) : null,
            currentPeriodEnd: workspace.current_period_ends_at ? text(workspace.current_period_ends_at) : null,
            contractedMonthlyPriceCents: Number(workspace.contracted_monthly_price_cents ?? 0),
          },
          plan: {
            code: text(workspace.plan_code), name: text(workspace.plan_name),
            includedSeats: Number(workspace.included_seats ?? 0),
            companyLimit: Number(workspace.company_limit ?? 0),
            integrationLimit: Number(workspace.integration_limit ?? 0),
            storageLimitMb: Number(workspace.storage_limit_mb ?? 0),
          },
        },
        members: members.results.map((row) => ({
          userId: text(row.user_id), email: text(row.email), name: text(row.name), role: text(row.role),
          joinedAt: text(row.joined_at), status: text(row.status) || "active",
          isOwner: truthy(row.is_owner), isActivated: truthy(row.is_activated),
          lastSeenAt: row.last_seen_at ? text(row.last_seen_at) : null,
        })),
        companies: companies.results.map((row) => ({
          id: text(row.id), legalName: text(row.legal_name), tradeName: text(row.trade_name),
          taxId: text(row.tax_id), isPrincipal: truthy(row.is_principal), status: text(row.status),
        })),
        modules: modules.results.map((row) => ({
          key: text(row.key), name: text(row.name), category: text(row.category),
          inPlan: truthy(row.in_plan), grantedOverride: truthy(row.granted_override),
        })),
        audit: audit.results.map((row) => ({
          id: text(row.id), actorEmail: text(row.actor_email), action: text(row.action),
          entityType: text(row.entity_type), createdAt: text(row.created_at),
          after: row.after_json ? String(row.after_json).slice(0, 400) : "",
        })),
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
