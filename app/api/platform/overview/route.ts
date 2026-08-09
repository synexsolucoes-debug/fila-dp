import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { parseStringArray } from "@/lib/saas";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const [metrics, workspaces, plans, audits] = await Promise.all([
        d1.prepare(`SELECT
            COUNT(*)::integer AS workspaces,
            COUNT(*) FILTER (WHERE subscription.status IN ('trialing', 'active'))::integer AS subscribed,
            COUNT(*) FILTER (WHERE subscription.status = 'past_due')::integer AS past_due,
            COUNT(*) FILTER (WHERE onboarding.status = 'completed')::integer AS onboarded
          FROM fdp_workspaces workspace
          LEFT JOIN fdp_workspace_subscriptions subscription ON subscription.workspace_id = workspace.id
          LEFT JOIN fdp_workspace_onboarding onboarding ON onboarding.workspace_id = workspace.id`).first<Record<string, unknown>>(),
        d1.prepare(`SELECT workspace.id, workspace.name, workspace.slug, workspace.created_at,
            subscription.status AS subscription_status, subscription.billing_interval, subscription.seat_quantity,
            subscription.current_period_ends_at, plan.code AS plan_code, plan.name AS plan_name,
            onboarding.status AS onboarding_status, onboarding.current_step
          FROM fdp_workspaces workspace
          LEFT JOIN fdp_workspace_subscriptions subscription ON subscription.workspace_id = workspace.id
          LEFT JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id
          LEFT JOIN fdp_workspace_onboarding onboarding ON onboarding.workspace_id = workspace.id
          ORDER BY workspace.created_at DESC LIMIT 200`).all(),
        d1.prepare(`SELECT id, code, name, description, status, currency, monthly_price_cents, annual_price_cents,
            trial_days, included_seats, company_limit, integration_limit, storage_limit_mb, features_json,
            stripe_monthly_price_id, stripe_annual_price_id, position, updated_at
          FROM fdp_saas_plans ORDER BY position`).all<Record<string, unknown>>(),
        d1.prepare(`SELECT id, actor_email, action, entity_type, entity_id, after_json, request_id, created_at
          FROM fdp_platform_audit_events ORDER BY created_at DESC LIMIT 80`).all(),
      ]);
      return Response.json({
        metrics: {
          workspaces: Number(metrics?.workspaces ?? 0), subscribed: Number(metrics?.subscribed ?? 0),
          pastDue: Number(metrics?.past_due ?? 0), onboarded: Number(metrics?.onboarded ?? 0),
        },
        workspaces: workspaces.results,
        plans: plans.results.map((row) => ({
          id: row.id, code: row.code, name: row.name, description: row.description, status: row.status, currency: row.currency,
          monthlyPriceCents: Number(row.monthly_price_cents), annualPriceCents: Number(row.annual_price_cents), trialDays: Number(row.trial_days),
          includedSeats: Number(row.included_seats), companyLimit: Number(row.company_limit), integrationLimit: Number(row.integration_limit),
          storageLimitMb: Number(row.storage_limit_mb), features: parseStringArray(row.features_json),
          stripeMonthlyPriceId: row.stripe_monthly_price_id, stripeAnnualPriceId: row.stripe_annual_price_id,
          position: Number(row.position), updatedAt: row.updated_at,
        })),
        audits: audits.results,
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
