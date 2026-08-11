import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requireCapability } from "@/lib/authorization";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { appBaseUrl, validBillingInterval, validPlanCode } from "@/lib/saas";
import { getStripe } from "@/lib/stripe";

type Body = { planCode?: string; billingInterval?: string; seatQuantity?: number };

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "saas.manage");
    const body = await request.json() as Body;
    const planCode = validPlanCode(body.planCode);
    const billingInterval = validBillingInterval(body.billingInterval);
    const memberCount = await d1.prepare("SELECT COUNT(*)::integer AS count FROM fdp_workspace_members WHERE workspace_id = ?").bind(workspace.id).first<{ count: number }>();
    const seatQuantity = Math.max(Number(memberCount?.count ?? 1), Math.min(500, Math.trunc(Number(body.seatQuantity ?? memberCount?.count ?? 1)) || 1));
    const record = await d1.prepare(`SELECT plan.id AS plan_id, plan.code, plan.name, plan.status,
        plan.stripe_monthly_price_id, plan.stripe_annual_price_id,
        subscription.id AS subscription_id, subscription.external_customer_id
      FROM fdp_saas_plans plan
      JOIN fdp_workspace_subscriptions subscription ON subscription.workspace_id = ?
      WHERE plan.code = ? AND plan.status = 'active'`).bind(workspace.id, planCode).first<Record<string, unknown>>();
    if (!record) return Response.json({ error: "Plano indisponível para contratação." }, { status: 404 });
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
    const metadata = { workspaceId: workspace.id, planCode, billingInterval, seatQuantity: String(seatQuantity) };
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: workspace.id,
      line_items: [{ price: priceId, quantity: seatQuantity }],
      allow_promotion_codes: true,
      success_url: `${baseUrl}/painel?saas=success`,
      cancel_url: `${baseUrl}/painel?saas=cancel`,
      metadata,
      subscription_data: { metadata },
    }, { idempotencyKey: `fila-dp-checkout-${workspace.id}-${planCode}-${billingInterval}-${seatQuantity}-${new Date().toISOString().slice(0, 13)}` });
    if (!session.url || !session.url.startsWith("https://")) throw new Error("Stripe did not return a secure checkout URL.");
    await d1.batch([
      d1.prepare("UPDATE fdp_workspace_subscriptions SET billing_interval = ?, seat_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?").bind(billingInterval, seatQuantity, workspace.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: user.email, action: "saas.checkout_started", entityType: "subscription", entityId: String(record.subscription_id), after: { planCode, billingInterval, seatQuantity } }),
    ]);
    return Response.json({ url: session.url });
  } catch (error) { return apiError(error); }
}
