import type {
  BillingInterval, Invoice, Onboarding, OnboardingProfile, OnboardingStep, SaasOverview, SaasPlan, Subscription,
} from "./saas.types";

type Row = Record<string, unknown>;
const value = (row: Row, camel: string, snake = camel) => row[camel] ?? row[snake];
const text = (input: unknown) => input == null ? "" : String(input);
const number = (input: unknown) => Number(input) || 0;
const bool = (input: unknown) => input === true || input === 1 || input === "true" || input === "1";
const object = (input: unknown): Row => input && typeof input === "object" && !Array.isArray(input) ? input as Row : {};
const strings = (input: unknown) => Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
const validSteps = new Set(["company", "team", "operation", "integrations", "billing"]);
const steps = (input: unknown) => strings(input).filter((item): item is OnboardingStep => validSteps.has(item));

export async function requestSaas<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function normalizePlan(input: unknown): SaasPlan {
  const row = object(input);
  const checkout = object(row.checkout);
  return {
    id: text(row.id), code: text(row.code), name: text(row.name), description: text(row.description), status: text(row.status),
    currency: text(row.currency) || "BRL", monthlyPriceCents: number(value(row, "monthlyPriceCents", "monthly_price_cents")),
    annualPriceCents: number(value(row, "annualPriceCents", "annual_price_cents")), trialDays: number(value(row, "trialDays", "trial_days")),
    includedSeats: number(value(row, "includedSeats", "included_seats")), companyLimit: number(value(row, "companyLimit", "company_limit")),
    integrationLimit: number(value(row, "integrationLimit", "integration_limit")), storageLimitMb: number(value(row, "storageLimitMb", "storage_limit_mb")),
    features: strings(row.features), checkout: { monthly: bool(checkout.monthly), annual: bool(checkout.annual) },
  };
}

function normalizeSubscription(input: unknown): Subscription | null {
  const row = object(input);
  if (!row.id) return null;
  const plan = object(row.plan);
  return {
    id: text(row.id), status: text(row.status), billingInterval: text(value(row, "billingInterval", "billing_interval")) === "annual" ? "annual" : "monthly",
    seatQuantity: number(value(row, "seatQuantity", "seat_quantity")), provider: text(row.provider), trialEndsAt: text(value(row, "trialEndsAt", "trial_ends_at")),
    currentPeriodStartsAt: text(value(row, "currentPeriodStartsAt", "current_period_starts_at")), currentPeriodEndsAt: text(value(row, "currentPeriodEndsAt", "current_period_ends_at")),
    cancelAtPeriodEnd: bool(value(row, "cancelAtPeriodEnd", "cancel_at_period_end")), canceledAt: text(value(row, "canceledAt", "canceled_at")),
    plan: { id: text(plan.id), code: text(plan.code), name: text(plan.name) },
  };
}

function normalizeOnboarding(input: unknown): Onboarding | null {
  const row = object(input);
  if (!row.status) return null;
  const profile = object(row.profile);
  return {
    status: text(row.status), currentStep: text(value(row, "currentStep", "current_step")),
    completedSteps: steps(value(row, "completedSteps", "completed_steps")), skippedSteps: steps(value(row, "skippedSteps", "skipped_steps")),
    profile: { teamSize: text(value(profile, "teamSize", "team_size")), primaryGoal: text(value(profile, "primaryGoal", "primary_goal")), source: text(profile.source) },
    completedAt: text(value(row, "completedAt", "completed_at")), updatedAt: text(value(row, "updatedAt", "updated_at")),
  };
}

function normalizeInvoice(input: unknown): Invoice {
  const row = object(input);
  return {
    id: text(row.id), status: text(row.status), currency: text(row.currency) || "BRL", amountDueCents: number(value(row, "amountDueCents", "amount_due_cents")),
    amountPaidCents: number(value(row, "amountPaidCents", "amount_paid_cents")), hostedInvoiceUrl: text(value(row, "hostedInvoiceUrl", "hosted_invoice_url")),
    periodStartsAt: text(value(row, "periodStartsAt", "period_starts_at")), periodEndsAt: text(value(row, "periodEndsAt", "period_ends_at")),
    paidAt: text(value(row, "paidAt", "paid_at")), createdAt: text(value(row, "createdAt", "created_at")),
  };
}

export function normalizeSaasOverview(input: unknown): SaasOverview {
  const row = object(input);
  const workspace = object(row.workspace); const usage = object(row.usage); const permissions = object(row.permissions);
  return {
    workspace: { id: text(workspace.id), name: text(workspace.name) },
    plans: Array.isArray(row.plans) ? row.plans.map(normalizePlan) : [], subscription: normalizeSubscription(row.subscription), onboarding: normalizeOnboarding(row.onboarding),
    invoices: Array.isArray(row.invoices) ? row.invoices.map(normalizeInvoice) : [],
    usage: { members: number(usage.members), companies: number(usage.companies), integrations: number(usage.integrations), storageMb: number(value(usage, "storageMb", "storage_mb")) },
    permissions: { manage: bool(permissions.manage), platform: bool(permissions.platform) },
  };
}

export async function updateOnboarding(action: string, options: { step?: OnboardingStep; profile?: OnboardingProfile } = {}) {
  return requestSaas<{ onboarding: Onboarding }>("/api/saas/onboarding", { method: "PATCH", body: JSON.stringify({ action, ...options }) });
}

export async function startCheckout(planCode: string, billingInterval: BillingInterval, seatQuantity: number) {
  return requestSaas<{ url: string }>("/api/saas/checkout", { method: "POST", body: JSON.stringify({ planCode, billingInterval, seatQuantity }) });
}

export async function openBillingPortal() {
  return requestSaas<{ url: string }>("/api/saas/portal", { method: "POST" });
}

export function navigateToHttps(url: string) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("O provedor não retornou uma URL HTTPS segura.");
  window.location.assign(target.href);
}
