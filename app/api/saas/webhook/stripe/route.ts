import { getD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { getStripe, projectStripeEvent, stripeWebhookSecret } from "@/lib/stripe";
import { setTenantContext } from "@/lib/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const supportedEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
]);

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Assinatura ausente." }, { status: 400 });
  let event;
  try {
    const rawBody = await request.text();
    event = getStripe().webhooks.constructEvent(rawBody, signature, stripeWebhookSecret());
  } catch {
    return Response.json({ error: "Assinatura inválida." }, { status: 400 });
  }

  try {
    const projection = projectStripeEvent(event);
    if (!/^[0-9a-f-]{36}$/iu.test(projection.workspaceId)) {
      return Response.json({ received: true, ignored: true }, { status: 202 });
    }
    setTenantContext({ workspaceId: projection.workspaceId, userId: "stripe" });
    const d1 = getD1();
    const workspace = await d1.prepare("SELECT id FROM fdp_workspaces WHERE id = ?").bind(projection.workspaceId).first<{ id: string }>();
    if (!workspace) return Response.json({ received: true, ignored: true }, { status: 202 });
    const isSupported = supportedEvents.has(projection.eventType);
    const summary = JSON.stringify({
      customerId: projection.customerId,
      subscriptionId: projection.subscriptionId,
      planCode: projection.planCode,
      planPriceId: projection.planPriceId,
      billingInterval: projection.billingInterval,
      invoiceId: projection.invoice?.id ?? "",
      amountDueCents: projection.invoice?.amountDueCents ?? 0,
      amountPaidCents: projection.invoice?.amountPaidCents ?? 0,
    });

    if (!isSupported) {
      await d1.prepare(`INSERT INTO fdp_billing_events
        (id, workspace_id, external_event_id, event_type, status, object_type, object_id, summary_json, processed_at)
        VALUES (?, ?, ?, ?, 'ignored', ?, ?, ?::jsonb, CURRENT_TIMESTAMP)
        ON CONFLICT (external_event_id) DO NOTHING`)
        .bind(crypto.randomUUID(), projection.workspaceId, projection.eventId, projection.eventType, projection.objectType, projection.objectId, summary).run();
      return Response.json({ received: true, ignored: true });
    }

    if (projection.invoice) {
      const subscription = await d1.prepare("SELECT id FROM fdp_workspace_subscriptions WHERE workspace_id = ? AND external_subscription_id = ?")
        .bind(projection.workspaceId, projection.subscriptionId).first<{ id: string }>();
      if (!subscription) return Response.json({ received: true, ignored: true }, { status: 202 });
      const invoiceStatus = projection.eventType === "invoice.payment_failed" ? "open" : projection.invoice.status;
      const subscriptionStatus = projection.eventType === "invoice.payment_failed" ? "past_due" : "active";
      await d1.prepare(`WITH inserted_event AS (
          INSERT INTO fdp_billing_events (id, workspace_id, external_event_id, event_type, status, object_type, object_id, summary_json, processed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, CURRENT_TIMESTAMP)
          ON CONFLICT (external_event_id) DO NOTHING RETURNING id
        ), invoice_upsert AS (
          INSERT INTO fdp_billing_invoices
            (id, workspace_id, subscription_id, external_invoice_id, status, currency, amount_due_cents, amount_paid_cents, hosted_invoice_url, paid_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM inserted_event)
          ON CONFLICT (external_invoice_id) DO UPDATE SET
            status = EXCLUDED.status, amount_due_cents = EXCLUDED.amount_due_cents, amount_paid_cents = EXCLUDED.amount_paid_cents,
            hosted_invoice_url = EXCLUDED.hosted_invoice_url, paid_at = EXCLUDED.paid_at, updated_at = CURRENT_TIMESTAMP
          RETURNING id
        )
        UPDATE fdp_workspace_subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1
        WHERE workspace_id = ? AND id = ? AND EXISTS (SELECT 1 FROM inserted_event)`)
        .bind(
          crypto.randomUUID(), projection.workspaceId, projection.eventId, projection.eventType, isSupported ? "processed" : "ignored",
          projection.objectType, projection.objectId, summary,
          crypto.randomUUID(), projection.workspaceId, subscription.id, projection.invoice.id, invoiceStatus, projection.invoice.currency,
          projection.invoice.amountDueCents, projection.invoice.amountPaidCents, projection.invoice.hostedInvoiceUrl, projection.invoice.paidAt,
          subscriptionStatus, projection.workspaceId, subscription.id,
        ).run();
    } else {
      await d1.prepare(`WITH inserted_event AS (
          INSERT INTO fdp_billing_events (id, workspace_id, external_event_id, event_type, status, object_type, object_id, summary_json, processed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, CURRENT_TIMESTAMP)
          ON CONFLICT (external_event_id) DO NOTHING RETURNING id
        )
        UPDATE fdp_workspace_subscriptions subscription SET
          plan_id = COALESCE((SELECT price.plan_id FROM fdp_saas_plan_prices price
            JOIN fdp_saas_plans plan ON plan.id = price.plan_id
            WHERE price.id = ? AND plan.code = ?), subscription.plan_id),
          plan_price_id = COALESCE((SELECT price.id FROM fdp_saas_plan_prices price
            JOIN fdp_saas_plans plan ON plan.id = price.plan_id
            WHERE price.id = ? AND plan.code = ?), subscription.plan_price_id),
          contracted_monthly_price_cents = COALESCE((SELECT price.monthly_price_cents FROM fdp_saas_plan_prices price
            WHERE price.id = ?), subscription.contracted_monthly_price_cents),
          contracted_price_cents = COALESCE((SELECT CASE WHEN ? = 'annual' THEN price.annual_price_cents ELSE price.monthly_price_cents END
            FROM fdp_saas_plan_prices price WHERE price.id = ?), subscription.contracted_price_cents),
          contracted_currency = COALESCE((SELECT price.currency FROM fdp_saas_plan_prices price
            WHERE price.id = ?), subscription.contracted_currency),
          provider = CASE WHEN ? = '' THEN subscription.provider ELSE 'stripe' END,
          status = CASE WHEN ? = '' THEN subscription.status ELSE ? END,
          billing_interval = CASE WHEN ? = '' THEN subscription.billing_interval ELSE ? END,
          seat_quantity = COALESCE((SELECT price.included_seats FROM fdp_saas_plan_prices price
            WHERE price.id = ?), subscription.seat_quantity),
          external_customer_id = CASE WHEN ? = '' THEN subscription.external_customer_id ELSE ? END,
          external_subscription_id = CASE WHEN ? = '' THEN subscription.external_subscription_id ELSE ? END,
          current_period_starts_at = COALESCE(?::timestamptz, subscription.current_period_starts_at),
          current_period_ends_at = COALESCE(?::timestamptz, subscription.current_period_ends_at),
          cancel_at_period_end = ?,
          canceled_at = CASE WHEN ? = 'canceled' THEN CURRENT_TIMESTAMP ELSE subscription.canceled_at END,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
        WHERE subscription.workspace_id = ? AND EXISTS (SELECT 1 FROM inserted_event)`)
        .bind(
          crypto.randomUUID(), projection.workspaceId, projection.eventId, projection.eventType, isSupported ? "processed" : "ignored",
          projection.objectType, projection.objectId, summary,
          projection.planPriceId, projection.planCode, projection.planPriceId, projection.planCode,
          projection.planPriceId, projection.billingInterval, projection.planPriceId, projection.planPriceId,
          projection.subscriptionId,
          projection.subscriptionStatus, projection.subscriptionStatus,
          projection.billingInterval, projection.billingInterval, projection.planPriceId,
          projection.customerId, projection.customerId, projection.subscriptionId, projection.subscriptionId,
          projection.currentPeriodStartsAt, projection.currentPeriodEndsAt, projection.cancelAtPeriodEnd ? 1 : 0,
          projection.subscriptionStatus, projection.workspaceId,
        ).run();
    }
    return Response.json({ received: true });
  } catch (error) { return apiError(error); }
}
