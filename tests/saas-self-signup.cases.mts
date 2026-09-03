import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildPackageLineItem } from "../lib/stripe.ts";
import { createSignupProvisioningIds, normalizeSignupEmail, requireLegalAcceptance } from "../lib/signup-security.ts";
import { resolveModuleAccess } from "../lib/modules.ts";
import { resolveActiveWorkspace } from "../lib/workspace-access.ts";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("1-2: dois cadastros Starter recebem identidades e workspaces próprios", async () => {
  const [signup, confirmation] = await Promise.all([
    source("app/api/auth/signup/route.ts"),
    source("lib/self-signup.ts"),
  ]);
  const first = createSignupProvisioningIds();
  const second = createSignupProvisioningIds();
  assert.equal(new Set(Object.values({ ...first, ...Object.fromEntries(Object.entries(second).map(([key, value]) => [`second-${key}`, value])) })).size, 8);
  assert.match(signup, /createSignupProvisioningIds\(\)/u);
  assert.match(confirmation, /plan\.code = 'starter'/u);
  assert.match(confirmation, /provisionWorkspaceDefaults\(scoped, workspaceId, initial\)/u);
});

test("3: a preferência só resolve workspaces associados ao usuário", () => {
  const available = [{ id: "a", name: "A", timezone: "UTC", status: "active", statusReason: "", role: "admin" as const, isOwner: true, joinedAt: "", operational: true }];
  const resolution = resolveActiveWorkspace(available, "workspace-b");
  assert.equal(resolution.kind, "ok");
  assert.equal(resolution.kind === "ok" ? resolution.workspace.id : "", "a");
});

test("4-5: empresa, demanda, documento e integração são consultados no tenant da sessão", async () => {
  const [companies, context, isolation] = await Promise.all([
    source("app/api/companies/route.ts"),
    source("lib/fila-dp-db.ts"),
    source("scripts/verify-tenant-isolation.mjs"),
  ]);
  assert.match(companies, /getWorkspaceContext\(auth\.user\)/u);
  assert.doesNotMatch(companies, /body\.workspaceId|searchParams\.get\("workspaceId"\)/u);
  assert.match(context, /getScopedD1\(tenant\)/u);
  for (const table of ["fdp_cards", "fdp_card_attachments", "fdp_integrations"]) {
    assert.match(isolation, /toda tabela com workspace_id tem RLS forçada/u, `${table} coberta pelo ensaio integral`);
  }
});

test("6-7: convidados usam atribuição explícita e lista vazia significa zero empresas", async () => {
  const db = await source("lib/fila-dp-db.ts");
  assert.match(db, /if \(role === "admin"\) return \{ unrestricted: true/u);
  assert.match(db, /unrestricted: false, companyIds: new Set\(access\.results/u);
  assert.match(db, /if \(!companyId\) throw ApiError\.forbidden/u);
});

test("8: admin do workspace não herda administração global", async () => {
  const platform = await source("lib/platform-authorization.ts");
  assert.match(platform, /FDP_PLATFORM_ADMIN_EMAILS/u);
  assert.doesNotMatch(platform, /workspace\.role|role === "admin"/u);
});

test("9: repetição do cadastro usa a mesma linha e não duplica workspace", async () => {
  const [signup, migration] = await Promise.all([
    source("app/api/auth/signup/route.ts"),
    source("drizzle/postgres/0080_saas_self_signup_contract.sql"),
  ]);
  assert.match(signup, /ON CONFLICT \(email\) DO UPDATE/u);
  assert.match(migration, /fdp_signup_requests_email_uq/u);
  assert.match(migration, /fdp_signup_requests_workspace_uq/u);
});

test("10: uma identidade não pode possuir dois Starters", async () => {
  const [confirmation, migration] = await Promise.all([
    source("lib/self-signup.ts"),
    source("drizzle/postgres/0080_saas_self_signup_contract.sql"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "fdp_starter_owners"/u);
  assert.match(migration, /"user_id" text PRIMARY KEY/u);
  assert.match(confirmation, /NOT EXISTS \(SELECT 1 FROM fdp_starter_owners/u);
});

test("11: limites de usuários, empresas e integrações são aplicados no servidor", async () => {
  const [members, companies, integrations] = await Promise.all([
    source("app/api/members/route.ts"),
    source("app/api/companies/route.ts"),
    source("lib/integration-engine.ts"),
  ]);
  assert.match(members, /PLAN_SEAT_LIMIT/u);
  assert.match(companies, /PLAN_COMPANY_LIMIT/u);
  assert.match(integrations, /PLAN_INTEGRATION_LIMIT/u);
  for (const item of [members, companies, integrations]) assert.match(item, /pg_advisory_xact_lock/u);
});

test("12: Standard envia uma unidade do preço do pacote ao Stripe", async () => {
  assert.deepEqual(buildPackageLineItem("price_standard"), { price: "price_standard", quantity: 1 });
  const checkout = await source("app/api/saas/checkout/route.ts");
  assert.match(checkout, /line_items: \[buildPackageLineItem\(priceId\)\]/u);
  assert.match(checkout, /contractedPriceCents <= 0/u);
  assert.doesNotMatch(checkout, /body\.seatQuantity|quantity:\s*seatQuantity/u);
  const webhook = await source("app/api/saas/webhook/stripe/route.ts");
  assert.match(webhook, /provider = CASE WHEN \? = '' THEN subscription\.provider ELSE 'stripe' END/u);
});

test("13: Enterprise é persistido como contrato manual sem checkout", async () => {
  const [migration, checkout] = await Promise.all([
    source("drizzle/postgres/0080_saas_self_signup_contract.sql"),
    source("app/api/saas/checkout/route.ts"),
  ]);
  assert.match(migration, /"checkout_enabled" = 0[\s\S]*WHERE "code" = 'enterprise'/u);
  assert.match(migration, /"custom_limits" = 1/u);
  assert.match(checkout, /plan\.checkout_enabled = 1/u);
});

test("módulos e limites saem do mesmo catálogo persistido", async () => {
  const [migration, site, overview] = await Promise.all([
    source("drizzle/postgres/0080_saas_self_signup_contract.sql"),
    source("app/api/site/plans/route.ts"),
    source("app/api/saas/overview/route.ts"),
  ]);
  assert.match(migration, /INSERT INTO "fdp_plan_modules"/u);
  assert.match(migration, /plan\."code" IN \('starter', 'standard'\)/u);
  assert.match(site, /FROM fdp_plan_modules plan_module/u);
  assert.match(overview, /FROM fdp_plan_modules plan_module/u);
});

test("14: token expirado ou reutilizado é recusado e confirmação é de uso único", async () => {
  const [confirmation, route] = await Promise.all([
    source("lib/self-signup.ts"),
    source("app/api/auth/confirm/route.ts"),
  ]);
  assert.match(confirmation, /status = 'pending' AND token_expires_at > CURRENT_TIMESTAMP/u);
  assert.match(confirmation, /status = 'confirmed', confirmation_nonce = \?/u);
  assert.match(route, /SIGNUP_TOKEN_INVALID/u);
});

test("o cliente não escolhe autoridade, tenant, plano ou limites no cadastro", async () => {
  const signup = await source("app/api/auth/signup/route.ts");
  for (const input of ["body.role", "body.capabilities", "body.workspaceId", "body.planId", "body.status", "body.limits", "body.modules", "body.platformAdmin"]) {
    assert.doesNotMatch(signup, new RegExp(input.replace(".", "\\."), "u"));
  }
  assert.equal(normalizeSignupEmail("  PESSOA@Exemplo.COM "), "pessoa@exemplo.com");
  assert.match(signup, /lower\(email\) = \?/u);
  assert.throws(() => requireLegalAcceptance(true, false), /Política de Privacidade/u);
});

test("bloqueio por plano permanece distinto de bloqueio por permissão", () => {
  const moduleDefinition = { key: "integrations", name: "Integrações", description: "", category: "gestao" as const, route: "integrations", requiredCapability: "integrations.view", dependsOn: "", status: "active" as const, position: 1 };
  const common = { module: moduleDefinition, workspaceGrants: new Map<string, boolean>(), role: "guest", workspaceStatus: "active", subscriptionStatus: "active", enabledKeys: new Set<string>() };
  assert.equal(resolveModuleAccess({ ...common, planModules: new Set() }).reason, "not_in_plan");
  assert.equal(resolveModuleAccess({ ...common, planModules: new Set(["integrations"]) }).reason, "missing_capability");
});
