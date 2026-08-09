import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { evaluateBillingReadiness } from "@/lib/billing-readiness";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { selfSignupEnabled } from "@/lib/saas";

export const dynamic = "force-dynamic";

/**
 * Diagnóstico de prontidão da cobrança.
 *
 * Responde à pergunta que separa "código pronto" de "posso vender": as chaves
 * estão configuradas, existe plano publicado com preço, e o webhook e o checkout
 * já funcionaram de verdade pelo menos uma vez?
 */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const [plans, events, subscriptions, invoices] = await Promise.all([
        d1.prepare(`SELECT code, status, monthly_price_cents, annual_price_cents, stripe_monthly_price_id, stripe_annual_price_id
          FROM fdp_saas_plans ORDER BY position, code`).all<Record<string, unknown>>(),
        d1.prepare(`SELECT
            count(*) FILTER (WHERE status = 'processed')::int AS processed,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM fdp_billing_events`).first<{ processed: number; failed: number }>(),
        d1.prepare("SELECT count(*)::int AS total FROM fdp_workspace_subscriptions WHERE status IN ('trialing', 'active')")
          .first<{ total: number }>(),
        d1.prepare("SELECT count(*)::int AS total FROM fdp_billing_invoices WHERE status = 'paid'").first<{ total: number }>(),
      ]);

      const readiness = evaluateBillingReadiness({
        stripeSecretConfigured: Boolean(String(process.env.STRIPE_SECRET_KEY ?? "").trim()),
        stripeWebhookSecretConfigured: Boolean(String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim()),
        publicUrlConfigured: Boolean(String(process.env.FDP_APP_URL ?? "").trim()),
        selfSignupEnabled: selfSignupEnabled(),
        plans: plans.results.map((row) => ({
          code: String(row.code),
          status: String(row.status),
          monthlyPriceCents: Number(row.monthly_price_cents ?? 0),
          annualPriceCents: Number(row.annual_price_cents ?? 0),
          stripeMonthlyPriceId: String(row.stripe_monthly_price_id ?? ""),
          stripeAnnualPriceId: String(row.stripe_annual_price_id ?? ""),
        })),
        processedWebhookEvents: Number(events?.processed ?? 0),
        failedWebhookEvents: Number(events?.failed ?? 0),
        activeSubscriptions: Number(subscriptions?.total ?? 0),
        paidInvoices: Number(invoices?.total ?? 0),
      });

      // Nenhum segredo é devolvido: apenas se está configurado ou não.
      return Response.json(readiness, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return apiError(error);
  }
}
