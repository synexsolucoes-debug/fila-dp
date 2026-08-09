import Stripe from "stripe";
import { ApiError } from "./api-errors.ts";

let stripeClient: Stripe | null = null;

export function getStripe() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!secretKey) {
    throw new ApiError(503, "STRIPE_NOT_CONFIGURED", "A cobrança ainda não foi configurada para este ambiente.");
  }
  if (!stripeClient) stripeClient = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 10_000 });
  return stripeClient;
}

export function stripeWebhookSecret() {
  const value = String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!value) throw new ApiError(503, "STRIPE_WEBHOOK_NOT_CONFIGURED", "O webhook de cobrança não está configurado.");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectId(value: unknown) {
  if (typeof value === "string") return value;
  return typeof record(value).id === "string" ? String(record(value).id) : "";
}

function unixTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

function httpsUrl(value: unknown) {
  if (typeof value !== "string" || !value) return "";
  try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; }
}

export type StripeEventProjection = {
  eventId: string;
  eventType: string;
  workspaceId: string;
  objectType: string;
  objectId: string;
  customerId: string;
  subscriptionId: string;
  planCode: string;
  billingInterval: "monthly" | "annual" | "";
  seatQuantity: number;
  subscriptionStatus: "trialing" | "active" | "past_due" | "paused" | "canceled" | "incomplete" | "";
  cancelAtPeriodEnd: boolean;
  currentPeriodStartsAt: string | null;
  currentPeriodEndsAt: string | null;
  invoice: null | {
    id: string;
    status: "draft" | "open" | "paid" | "void" | "uncollectible";
    currency: string;
    amountDueCents: number;
    amountPaidCents: number;
    hostedInvoiceUrl: string;
    paidAt: string | null;
  };
};

export function projectStripeEvent(event: Stripe.Event): StripeEventProjection {
  const object = record(event.data.object);
  const metadata = record(object.metadata);
  const parent = record(object.parent);
  const subscriptionDetails = Object.keys(record(object.subscription_details)).length
    ? record(object.subscription_details)
    : record(parent.subscription_details);
  const subscriptionMetadata = record(subscriptionDetails.metadata);
  const workspaceId = String(metadata.workspaceId ?? metadata.workspace_id ?? subscriptionMetadata.workspaceId ?? subscriptionMetadata.workspace_id ?? object.client_reference_id ?? "");
  const rawInterval = String(metadata.billingInterval ?? metadata.billing_interval ?? subscriptionMetadata.billingInterval ?? subscriptionMetadata.billing_interval ?? "");
  const rawStatus = String(object.status ?? "");
  const allowedStatuses = new Set(["trialing", "active", "past_due", "paused", "canceled", "incomplete"]);
  const invoiceStatuses = new Set(["draft", "open", "paid", "void", "uncollectible"]);
  const isInvoice = event.type.startsWith("invoice.");
  return {
    eventId: event.id,
    eventType: event.type,
    workspaceId,
    objectType: String(object.object ?? ""),
    objectId: String(object.id ?? ""),
    customerId: objectId(object.customer),
    subscriptionId: event.type.startsWith("customer.subscription.") ? String(object.id ?? "") : objectId(object.subscription) || objectId(subscriptionDetails.subscription),
    planCode: String(metadata.planCode ?? metadata.plan_code ?? subscriptionMetadata.planCode ?? subscriptionMetadata.plan_code ?? "").toLowerCase(),
    billingInterval: rawInterval === "annual" ? "annual" : rawInterval === "monthly" ? "monthly" : "",
    seatQuantity: Math.max(1, Math.min(500, Number(metadata.seatQuantity ?? metadata.seat_quantity ?? 1) || 1)),
    subscriptionStatus: allowedStatuses.has(rawStatus) ? rawStatus as StripeEventProjection["subscriptionStatus"] : event.type === "checkout.session.completed" ? "active" : "",
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
    currentPeriodStartsAt: unixTimestamp(object.current_period_start),
    currentPeriodEndsAt: unixTimestamp(object.current_period_end),
    invoice: isInvoice ? {
      id: String(object.id ?? ""),
      status: invoiceStatuses.has(rawStatus) ? rawStatus as NonNullable<StripeEventProjection["invoice"]>["status"] : "open",
      currency: /^[a-z]{3}$/u.test(String(object.currency ?? "")) ? String(object.currency) : "brl",
      amountDueCents: Math.max(0, Number(object.amount_due ?? 0) || 0),
      amountPaidCents: Math.max(0, Number(object.amount_paid ?? 0) || 0),
      hostedInvoiceUrl: httpsUrl(object.hosted_invoice_url),
      paidAt: unixTimestamp(record(object.status_transitions).paid_at),
    } : null,
  };
}
