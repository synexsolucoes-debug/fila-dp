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

test("self-service signup replaces the singleton bootstrap without weakening platform identity", async () => {
  const [signup, platformAuth, platformRoute] = await Promise.all([
    readFile(new URL("../app/api/auth/signup/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/platform-authorization.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/overview/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(signup, /FDP_ALLOW_SELF_SIGNUP|selfSignupEnabled/);
  assert.match(signup, /provisionWorkspaceDefaults\(d1, workspaceId, \[/);
  assert.match(signup, /fdp_workspace_subscriptions/);
  assert.doesNotMatch(signup, /fdp_bootstrap_guard|SELECT id FROM fdp_workspaces LIMIT 1/);
  assert.doesNotMatch(signup, /UPDATE fdp_users SET name/u);
  assert.match(platformAuth, /FDP_PLATFORM_ADMIN_EMAILS/);
  assert.doesNotMatch(platformAuth, /workspace\.role|role === "admin"/);
  assert.match(platformRoute, /withPlatformContext/);
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

test("SaaS administration stays isolated in admin-only workspace and platform surfaces", async () => {
  const [workspace, saasView, platform, login] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/saas/SaasView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plataforma/PlatformApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/login/LoginForm.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /isAdmin && <button title="Plano e ativação"/u);
  assert.match(saasView, /checkout|portal/u);
  assert.match(saasView, /company|team|operation|integrations|billing/u);
  assert.match(platform, /\/api\/platform\/plans\//u);
  assert.match(platform, /role="dialog"/u);
  assert.match(login, /signupEnabled/u);
  assert.match(login, /\/api\/auth\/signup/u);
  assert.doesNotMatch(`${saasView}\n${platform}\n${login}`, /localStorage|sessionStorage|location\.reload/u);
});
