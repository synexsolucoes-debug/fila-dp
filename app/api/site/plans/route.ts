import { getD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { selfSignupEnabled } from "@/lib/saas";

export const dynamic = "force-dynamic";

type PlanRow = {
  code: string; name: string; description: string; currency: string;
  monthly_price_cents: number; annual_price_cents: number; trial_days: number;
  included_seats: number; company_limit: number; integration_limit: number; storage_limit_mb: number;
  stripe_monthly_price_id: string;
  checkout_enabled: number; custom_limits: number;
  modules_json: unknown;
};

/**
 * Catálogo comercial publicado, para leitura pública.
 *
 * Devolve exatamente o que o site mostra: os planos ativos, com preço em
 * centavos como estão persistidos. `selfServiceCheckout` diz se aquele plano
 * pode ser contratado sozinho — o que exige preço configurado no provedor de
 * pagamento — para que nenhuma superfície ofereça um checkout inexistente.
 *
 * Nenhum dado de cliente passa por aqui: a resposta é a mesma para todo mundo.
 */
export async function GET() {
  try {
    const d1 = getD1();
    const rows = await d1.prepare(`SELECT code, name, description, currency, monthly_price_cents, annual_price_cents,
        trial_days, included_seats, company_limit, integration_limit, storage_limit_mb, stripe_monthly_price_id,
        checkout_enabled, custom_limits,
        (SELECT COALESCE(jsonb_agg(plan_module.module_key ORDER BY plan_module.module_key), '[]'::jsonb)
          FROM fdp_plan_modules plan_module WHERE plan_module.plan_id = fdp_saas_plans.id) AS modules_json
      FROM fdp_saas_plans WHERE status = 'active' ORDER BY position, monthly_price_cents`).all<PlanRow>();

    const signupOpen = selfSignupEnabled();
    return Response.json({
      signupOpen,
      plans: rows.results.map((plan) => {
        const payable = plan.monthly_price_cents > 0 && Boolean(plan.stripe_monthly_price_id) && plan.checkout_enabled === 1;
        return {
          code: plan.code,
          name: plan.name,
          description: plan.description,
          currency: plan.currency,
          monthlyPriceCents: plan.monthly_price_cents,
          annualPriceCents: plan.annual_price_cents,
          trialDays: plan.trial_days,
          includedSeats: plan.included_seats,
          companyLimit: plan.company_limit,
          integrationLimit: plan.integration_limit,
          storageLimitMb: plan.storage_limit_mb,
          customLimits: plan.custom_limits === 1,
          modules: Array.isArray(plan.modules_json) ? plan.modules_json.map(String) : [],
          selfServiceCheckout: plan.code === "starter" ? signupOpen : payable,
        };
      }),
    }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error) {
    return apiError(error);
  }
}
