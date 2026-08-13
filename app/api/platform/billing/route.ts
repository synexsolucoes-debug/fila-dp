import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const [subscriptions, invoices, events, leads, recentInvoices, recentEvents] = await Promise.all([
        d1.prepare(`SELECT
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'trialing')::int AS trials,
            count(*) FILTER (WHERE status = 'past_due')::int AS past_due,
            COALESCE(sum(contracted_monthly_price_cents) FILTER (WHERE status = 'active'), 0)::int AS mrr,
            COALESCE(sum(contracted_monthly_price_cents) FILTER (WHERE status = 'past_due'), 0)::int AS revenue_at_risk,
            count(*) FILTER (WHERE trial_ends_at IS NOT NULL)::int AS trials_total,
            count(*) FILTER (WHERE trial_ends_at IS NOT NULL AND status = 'active')::int AS trials_converted
          FROM fdp_workspace_subscriptions`).first<Record<string, unknown>>(),
        d1.prepare(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE status = 'uncollectible')::int AS uncollectible,
            COALESCE(sum(amount_due_cents - amount_paid_cents) FILTER (WHERE status IN ('open', 'uncollectible')), 0)::int AS outstanding,
            count(*) FILTER (WHERE status = 'paid')::int AS paid
          FROM fdp_billing_invoices`).first<Record<string, unknown>>(),
        d1.prepare("SELECT status, count(*)::int AS total FROM fdp_billing_events GROUP BY status").all<{ status: string; total: number }>(),
        d1.prepare("SELECT status, count(*)::int AS total FROM fdp_marketing_leads GROUP BY status").all<{ status: string; total: number }>(),
        d1.prepare(`SELECT invoice.id, workspace.name AS workspace_name, invoice.status, invoice.currency,
            invoice.amount_due_cents, invoice.amount_paid_cents, invoice.period_ends_at, invoice.created_at
          FROM fdp_billing_invoices invoice JOIN fdp_workspaces workspace ON workspace.id = invoice.workspace_id
          ORDER BY invoice.created_at DESC LIMIT 30`).all(),
        d1.prepare(`SELECT event.id, workspace.name AS workspace_name, event.event_type, event.status, event.error_code, event.received_at
          FROM fdp_billing_events event JOIN fdp_workspaces workspace ON workspace.id = event.workspace_id
          ORDER BY event.received_at DESC LIMIT 30`).all(),
      ]);
      const active = Number(subscriptions?.active ?? 0);
      const mrr = Number(subscriptions?.mrr ?? 0);
      const trialsTotal = Number(subscriptions?.trials_total ?? 0);
      const trialsConverted = Number(subscriptions?.trials_converted ?? 0);
      return Response.json({
        metrics: {
          mrrCents: mrr,
          mrrChange: { available: false, reason: "O modelo atual não persiste snapshots mensais de MRR." },
          revenueAtRiskCents: Number(subscriptions?.revenue_at_risk ?? 0) + Number(invoices?.outstanding ?? 0),
          delinquency: { workspaces: Number(subscriptions?.past_due ?? 0), openInvoices: Number(invoices?.open ?? 0), uncollectibleInvoices: Number(invoices?.uncollectible ?? 0) },
          trialConversionRate: trialsTotal > 0 ? Number(((trialsConverted / trialsTotal) * 100).toFixed(2)) : null,
          arpaCents: active > 0 ? Math.round(mrr / active) : null,
          revenueChurn: { available: false, reason: "Não há histórico mensal imutável suficiente para churn de receita." },
          ltv: { available: false, reason: "LTV não é exibido sem coorte e histórico de retenção suficientes." },
        },
        definitions: {
          mrr: "Soma de contracted_monthly_price_cents das assinaturas ativas no instante da consulta.",
          revenueAtRisk: "MRR past_due somado ao saldo em aberto de faturas open ou uncollectible.",
          trialConversion: "Assinaturas com trial_ends_at que hoje estão ativas dividido por todas que possuem trial_ends_at.",
          arpa: "MRR atual dividido pela quantidade de assinaturas ativas.",
        },
        subscriptions: { active, trials: Number(subscriptions?.trials ?? 0), pastDue: Number(subscriptions?.past_due ?? 0) },
        invoices: { ...invoices, recent: recentInvoices.results },
        webhookEvents: { totals: Object.fromEntries(events.results.map((row) => [row.status, Number(row.total)])), recent: recentEvents.results },
        leads: Object.fromEntries(leads.results.map((row) => [row.status, Number(row.total)])),
        configuration: {
          stripeSecretConfigured: Boolean(String(process.env.STRIPE_SECRET_KEY ?? "").trim()),
          stripeWebhookConfigured: Boolean(String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim()),
          publicUrlConfigured: Boolean(String(process.env.FDP_APP_URL ?? "").trim()),
        },
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return apiError(error); }
}
