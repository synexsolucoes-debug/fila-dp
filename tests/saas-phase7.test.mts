import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sanitizeOnboardingProfile, validBillingInterval, validOnboardingStep, validPlanCode } from "../lib/saas.ts";
import { projectStripeEvent } from "../lib/stripe.ts";

test("phase 7 persists tenant SaaS state with RLS and append-only financial ledgers", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0017_saas_foundation.sql", import.meta.url), "utf8"),
  ]);
  for (const table of ["fdp_workspace_subscriptions", "fdp_workspace_onboarding", "fdp_workspace_usage_counters", "fdp_billing_invoices", "fdp_billing_events"]) {
    assert.match(schema, new RegExp(table));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`${table}.*workspace_isolation`, "s"));
  }
  assert.match(schema, /fdp_saas_plans/);
  assert.match(schema, /fdp_platform_audit_events/);
  assert.match(migration, /fdp_billing_events_append_only/);
  assert.match(migration, /fdp_platform_audit_append_only/);
  assert.match(migration, /fdp_workspace_subscriptions_platform_read/);
  assert.match(migration, /'plan_starter', 'starter', 'Gratuito'/);
});

test("onboarding and plan inputs are allowlisted", () => {
  assert.equal(validOnboardingStep("company"), "company");
  assert.equal(validBillingInterval("annual"), "annual");
  assert.equal(validPlanCode("premium"), "premium");
  assert.throws(() => validOnboardingStep("arbitrary"), /inválida/u);
  assert.throws(() => validBillingInterval("weekly"), /inválida/u);
  assert.throws(() => validPlanCode("../admin"), /inválido/u);
  assert.deepEqual(sanitizeOnboardingProfile({ teamSize: "6-20", primaryGoal: "scale", source: "referral", secret: "no" }), {
    teamSize: "6-20", primaryGoal: "scale", source: "referral",
  });
});

test("Stripe events are projected to a safe, workspace-bound financial summary", () => {
  const projection = projectStripeEvent({
    id: "evt_123",
    type: "customer.subscription.updated",
    data: { object: {
      id: "sub_123", object: "subscription", customer: "cus_123", status: "active",
      current_period_start: 1_800_000_000, current_period_end: 1_802_592_000,
      metadata: { workspaceId: "00000000-0000-4000-8000-000000000001", planCode: "premium", billingInterval: "annual", seatQuantity: "12", token: "must-not-project" },
    } },
  } as never);
  assert.equal(projection.workspaceId, "00000000-0000-4000-8000-000000000001");
  assert.equal(projection.subscriptionId, "sub_123");
  assert.equal(projection.planCode, "premium");
  assert.equal(projection.seatQuantity, 12);
  assert.doesNotMatch(JSON.stringify(projection), /must-not-project/u);
});

test("checkout uses server-owned prices and signed webhooks authenticate before database access", async () => {
  const [checkout, webhook, requestSecurity] = await Promise.all([
    readFile(new URL("../app/api/saas/checkout/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/saas/webhook/stripe/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/request-security.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(checkout, /body\.priceId|body\["priceId"\]/u);
  assert.match(checkout, /stripe_monthly_price_id/);
  assert.match(checkout, /subscription_data: \{ metadata \}/);
  assert.ok(webhook.indexOf("constructEvent") < webhook.indexOf("getD1()"));
  assert.match(webhook, /ON CONFLICT \(external_event_id\) DO NOTHING/);
  assert.match(requestSecurity, /\/api\/saas\/webhook\/stripe/);
});

test("somente o administrador global provisiona ou exclui workspace", async () => {
  const [signup, login, setup, platformAuth, platformRoute, deleteRoute] = await Promise.all([
    readFile(new URL("../app/api/auth/signup/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/setup-status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/platform-authorization.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/workspaces/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/workspaces/[id]/delete/route.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(signup, /INSERT INTO fdp_workspaces|provisionWorkspaceDefaults/u);
  assert.match(signup, /provisionados exclusivamente pelo administrador global/u);
  assert.doesNotMatch(login, /INSERT INTO fdp_workspaces|fdp_bootstrap_guard/u);
  assert.match(login, /isPlatformAdmin/u);
  assert.match(setup, /setupRequired: false, signupEnabled: false/u);
  assert.match(platformAuth, /FDP_PLATFORM_ADMIN_EMAILS/);
  assert.doesNotMatch(platformAuth, /workspace\.role|role === "admin"/);
  assert.match(platformRoute, /requirePlatformAdmin/u);
  assert.match(platformRoute, /INSERT INTO fdp_workspaces/u);
  assert.match(deleteRoute, /requirePlatformAdmin/u);
  assert.match(deleteRoute, /WHERE w\.id = \?/u);
  assert.doesNotMatch(deleteRoute, /auth\.user[\s\S]{0,80}owner|owner_user_id\s*=\s*auth/u);
});

test("paid limits are enforced by the server under advisory locks", async () => {
  const [companies, members, integrations] = await Promise.all([
    readFile(new URL("../app/api/companies/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/integration-engine.ts", import.meta.url), "utf8"),
  ]);
  assert.match(companies, /pg_advisory_xact_lock/);
  assert.match(companies, /PLAN_COMPANY_LIMIT/);
  assert.match(members, /pg_advisory_xact_lock/);
  assert.match(members, /PLAN_SEAT_LIMIT/);
  assert.match(integrations, /pg_advisory_xact_lock/);
  assert.match(integrations, /PLAN_INTEGRATION_LIMIT/);
});

test("SaaS administration stays isolated in the global platform surface", async () => {
  const [workspace, platform, clients, billing, plansRoute, login] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plataforma/PlatformApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plataforma/features/ClientsFeature.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plataforma/features/BillingFeature.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/plans/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/login/LoginForm.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(workspace, /view === "saas"|Plano e ativação/u);
  assert.match(platform, /\["billing", "Financeiro", CreditCard\]/u);
  assert.match(clients, /Catálogo de planos/u);
  assert.match(billing, /MRR|Receita em risco/u);
  assert.match(plansRoute, /requirePlatformAdmin/u);
  assert.doesNotMatch(login, /signupEnabled|\/api\/auth\/signup|Criar conta/u);
  assert.doesNotMatch(`${platform}\n${clients}\n${billing}\n${login}`, /localStorage|sessionStorage|location\.reload/u);
});
