import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { isPlatformAdmin } from "@/lib/platform-authorization";
import { parseStringArray, publicPlan } from "@/lib/saas";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "saas.read");
    const [plans, subscription, onboarding, invoices, usage] = await Promise.all([
      d1.prepare(`SELECT id, code, name, description, status, currency, monthly_price_cents, annual_price_cents,
          trial_days, included_seats, company_limit, integration_limit, storage_limit_mb, features_json,
          stripe_monthly_price_id, stripe_annual_price_id, checkout_enabled, custom_limits,
          (SELECT COALESCE(jsonb_agg(plan_module.module_key ORDER BY plan_module.module_key), '[]'::jsonb)
            FROM fdp_plan_modules plan_module WHERE plan_module.plan_id = fdp_saas_plans.id) AS modules_json
        FROM fdp_saas_plans
        WHERE status = 'active' OR id = (SELECT plan_id FROM fdp_workspace_subscriptions WHERE workspace_id = ?)
        ORDER BY position`).bind(workspace.id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT subscription.id, subscription.status, subscription.billing_interval, subscription.seat_quantity,
          subscription.provider, subscription.trial_ends_at, subscription.current_period_starts_at,
          subscription.current_period_ends_at, subscription.cancel_at_period_end, subscription.canceled_at,
          plan.id AS plan_id, plan.code AS plan_code, plan.name AS plan_name
        FROM fdp_workspace_subscriptions subscription
        JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id
        WHERE subscription.workspace_id = ?`).bind(workspace.id).first<Record<string, unknown>>(),
      d1.prepare(`SELECT status, current_step, completed_steps_json, skipped_steps_json, profile_json, completed_at, updated_at
        FROM fdp_workspace_onboarding WHERE workspace_id = ?`).bind(workspace.id).first<Record<string, unknown>>(),
      d1.prepare(`SELECT id, status, currency, amount_due_cents, amount_paid_cents, hosted_invoice_url,
          period_starts_at, period_ends_at, paid_at, created_at
        FROM fdp_billing_invoices WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 12`).bind(workspace.id).all(),
      d1.prepare(`SELECT
          (SELECT COUNT(*)::integer FROM fdp_workspace_members WHERE workspace_id = ?) AS members,
          (SELECT COUNT(*)::integer FROM fdp_companies WHERE workspace_id = ? AND status = 'active') AS companies,
          (SELECT COUNT(*)::integer FROM fdp_integrations WHERE workspace_id = ? AND status = 'connected') AS integrations,
          CEIL((COALESCE((SELECT SUM(size_bytes) FROM fdp_card_attachments WHERE workspace_id = ?), 0)
            + COALESCE((SELECT SUM(size_bytes) FROM fdp_epi_attachments WHERE workspace_id = ?), 0)
            + COALESCE((SELECT SUM(size_bytes) FROM fdp_contractor_documents WHERE workspace_id = ?), 0)) / 1048576.0)::integer AS storage_mb`)
          .bind(workspace.id, workspace.id, workspace.id, workspace.id, workspace.id, workspace.id).first<Record<string, unknown>>(),
    ]);
    return Response.json({
      workspace: { id: workspace.id, name: workspace.name },
      plans: plans.results.map(publicPlan),
      subscription: subscription ? {
        id: String(subscription.id), status: String(subscription.status), billingInterval: String(subscription.billing_interval),
        seatQuantity: Number(subscription.seat_quantity), provider: String(subscription.provider),
        trialEndsAt: subscription.trial_ends_at, currentPeriodStartsAt: subscription.current_period_starts_at,
        currentPeriodEndsAt: subscription.current_period_ends_at, cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        canceledAt: subscription.canceled_at, plan: { id: String(subscription.plan_id), code: String(subscription.plan_code), name: String(subscription.plan_name) },
      } : null,
      onboarding: onboarding ? {
        status: String(onboarding.status), currentStep: String(onboarding.current_step),
        completedSteps: parseStringArray(onboarding.completed_steps_json), skippedSteps: parseStringArray(onboarding.skipped_steps_json),
        profile: onboarding.profile_json && typeof onboarding.profile_json === "object" ? onboarding.profile_json : {},
        completedAt: onboarding.completed_at, updatedAt: onboarding.updated_at,
      } : null,
      invoices: invoices.results,
      usage: {
        members: Number(usage?.members ?? 0), companies: Number(usage?.companies ?? 0),
        integrations: Number(usage?.integrations ?? 0), storageMb: Number(usage?.storage_mb ?? 0),
      },
      // `manage: true` fixo dizia que qualquer um que abre a tela pode
      // administrar a assinatura. A rota exige `saas.read`, que observador tem;
      // administrar exige `saas.manage`, que ele não tem. A tela mostrava a
      // ação e o servidor recusava — a permissão precisa vir da mesma fonte
      // que decide de verdade.
      permissions: {
        manage: hasCapability(workspace, "saas.manage"),
        exportData: hasCapability(workspace, "workspace.manage"),
        platform: isPlatformAdmin(auth.user),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
