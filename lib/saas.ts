import { ApiError } from "./api-errors.ts";

export const onboardingSteps = ["company", "team", "operation", "integrations", "billing"] as const;
export type OnboardingStep = typeof onboardingSteps[number];
export type BillingInterval = "monthly" | "annual";

const teamSizes = new Set(["1-5", "6-20", "21-50", "51-200", "201+"]);
const primaryGoals = new Set(["organize", "deadlines", "integrations", "governance", "scale"]);
const acquisitionSources = new Set(["search", "referral", "social", "partner", "other"]);

function enumValue(value: unknown, allowed: ReadonlySet<string>, fallback = "") {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.has(normalized) ? normalized : fallback;
}

export function sanitizeOnboardingProfile(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    teamSize: enumValue(input.teamSize, teamSizes),
    primaryGoal: enumValue(input.primaryGoal, primaryGoals),
    source: enumValue(input.source, acquisitionSources),
  };
}

export function validOnboardingStep(value: unknown): OnboardingStep {
  if (typeof value !== "string" || !onboardingSteps.includes(value as OnboardingStep)) {
    throw ApiError.badRequest("Etapa de onboarding inválida.", "INVALID_ONBOARDING_STEP");
  }
  return value as OnboardingStep;
}

export function validBillingInterval(value: unknown): BillingInterval {
  if (value !== "monthly" && value !== "annual") {
    throw ApiError.badRequest("Periodicidade de cobrança inválida.", "INVALID_BILLING_INTERVAL");
  }
  return value;
}

export function validPlanCode(value: unknown) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9_-]{1,39}$/u.test(code)) {
    throw ApiError.badRequest("Plano inválido.", "INVALID_PLAN");
  }
  return code;
}

export function parseStringArray(value: unknown) {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return []; } })() : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

export function appBaseUrl(request: Request) {
  const configured = String(process.env.FDP_APP_URL ?? "").trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
      throw new ApiError(503, "APP_URL_INVALID", "A URL pública do aplicativo precisa usar HTTPS.");
    }
    return url.origin;
  }
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(503, "APP_URL_NOT_CONFIGURED", "A URL pública do aplicativo não está configurada.");
  }
  return new URL(request.url).origin;
}

export function publicPlan(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: String(row.description ?? ""),
    status: String(row.status),
    currency: String(row.currency),
    monthlyPriceCents: Number(row.monthly_price_cents ?? 0),
    annualPriceCents: Number(row.annual_price_cents ?? 0),
    trialDays: Number(row.trial_days ?? 0),
    includedSeats: Number(row.included_seats ?? 0),
    companyLimit: Number(row.company_limit ?? 0),
    integrationLimit: Number(row.integration_limit ?? 0),
    storageLimitMb: Number(row.storage_limit_mb ?? 0),
    features: parseStringArray(row.features_json),
    checkout: {
      monthly: String(row.stripe_monthly_price_id ?? "").startsWith("price_"),
      annual: String(row.stripe_annual_price_id ?? "").startsWith("price_"),
    },
  };
}

export function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

export function selfSignupEnabled() {
  // Provisionamento é uma operação global auditada. Uma variável antiga não
  // pode reabrir criação pública de identidade e workspace.
  return false;
}

export function workspaceSlug(name: string) {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/(^-|-$)/gu, "").slice(0, 42) || "grupo";
  return `${normalized}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}
