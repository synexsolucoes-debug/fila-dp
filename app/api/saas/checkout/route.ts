import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requireCapability } from "@/lib/authorization";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { appBaseUrl, validBillingInterval, validPlanCode } from "@/lib/saas";
import { buildPackageLineItem, getStripe } from "@/lib/stripe";

type Body = { planCode?: string; billingInterval?: string };

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "saas.manage");
    const body = await request.json() as Body;
    const planCode = validPlanCode(body.planCode);
    const billingInterval = validBillingInterval(body.billingInterval);
    const record = await d1.prepare(`SELECT plan.id AS plan_id, plan.code, plan.name, plan.status,
        plan.stripe_monthly_price_id, plan.stripe_annual_price_id, plan.checkout_enabled,
        price.id AS plan_price_id, price.monthly_price_cents, price.annual_price_cents,
        price.included_seats, price.currency,
        subscription.id AS subscription_id, subscription.external_customer_id, subscription.version AS subscription_version
      FROM fdp_saas_plans plan
      JOIN fdp_workspace_subscriptions subscription ON subscription.workspace_id = ?
      JOIN LATERAL (
        SELECT id, monthly_price_cents, annual_price_cents, included_seats, currency
        FROM fdp_saas_plan_prices WHERE plan_id = plan.id
        ORDER BY effective_from DESC LIMIT 1
      ) price ON true
      WHERE plan.code = ? AND plan.status = 'active' AND plan.checkout_enabled = 1`)
      .bind(workspace.id, planCode).first<Record<string, unknown>>();
    if (!record) return Response.json({ error: "Plano indisponível para contratação." }, { status: 404 });
    const seatQuantity = Number(record.included_seats);
    const contractedPriceCents = Number(billingInterval === "annual" ? record.annual_price_cents : record.monthly_price_cents);
    if (!Number.isSafeInteger(contractedPriceCents) || contractedPriceCents <= 0) {
      return Response.json({ error: "Esta periodicidade não possui um preço vigente para contratação." }, { status: 409 });
    }
    const priceId = String(billingInterval === "annual" ? record.stripe_annual_price_id : record.stripe_monthly_price_id);
    if (!priceId.startsWith("price_")) {
      return Response.json({ error: "Este plano ainda não possui um preço publicado no provedor de cobrança." }, { status: 409 });
    }

    const stripe = getStripe();
    let customerId = String(record.external_customer_id ?? "");
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: workspace.name,
        metadata: { workspaceId: workspace.id },
      }, { idempotencyKey: `fila-dp-customer-${workspace.id}` });
      customerId = customer.id;
      await d1.prepare(`UPDATE fdp_workspace_subscriptions SET external_customer_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND external_customer_id = ''`).bind(customerId, workspace.id).run();
    }

    const baseUrl = appBaseUrl(request);
    const metadata = {
      workspaceId: workspace.id,
      planCode,
      planPriceId: String(record.plan_price_id),
      billingInterval,
      seatQuantity: String(seatQuantity),
      packageQuantity: "1",
    };
    const requestedIdempotencyKey = String(request.headers.get("x-idempotency-key") ?? "").trim();
    const requestKey = /^[A-Za-z0-9:_-]{8,64}$/u.test(requestedIdempotencyKey)
      ? requestedIdempotencyKey
      : new Date().toISOString().slice(0, 13);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: workspace.id,
      line_items: [buildPackageLineItem(priceId)],
      allow_promotion_codes: true,
      success_url: `${baseUrl}/painel?saas=success`,
      cancel_url: `${baseUrl}/painel?saas=cancel`,
      metadata,
      subscription_data: { metadata },
    }, { idempotencyKey: `vinculato-checkout-${workspace.id}-${record.plan_price_id}-${billingInterval}-${record.subscription_version}-${requestKey}` });
    if (!session.url || !session.url.startsWith("https://")) throw new Error("Stripe did not return a secure checkout URL.");
    await d1.batch([
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: user.email, action: "saas.checkout_started", entityType: "subscription", entityId: String(record.subscription_id), after: { planCode, planPriceId: record.plan_price_id, billingInterval, seatLimit: seatQuantity, packageQuantity: 1 } }),
    ]);
    return Response.json({ url: session.url });
  } catch (error) { return apiError(error); }
}
