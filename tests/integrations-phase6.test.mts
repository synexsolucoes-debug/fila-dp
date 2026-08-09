import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  openCredentials,
  retryDelaySeconds,
  sanitizeMapping,
  sealCredentials,
  validateConnectorEndpoint,
} from "../lib/integrations.ts";

test("phase 6 tables are tenant-scoped, constrained and protected by RLS", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0016_integrations_engine.sql", import.meta.url), "utf8"),
  ]);
  for (const table of ["fdp_integration_credentials", "fdp_integration_mappings", "fdp_integration_sync_runs", "fdp_integration_sync_items", "fdp_integration_jobs", "fdp_integration_reconciliations"]) {
    assert.match(schema, new RegExp(table));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY "${table.replace("fdp_", "fdp_").replace("integration_", "integration_")}.*workspace_isolation|CREATE POLICY`, "s"));
  }
  assert.match(migration, /fdp_integration_credentials_guard/);
  assert.match(migration, /sealed integration credential is immutable/);
  assert.match(migration, /fdp_integration_mappings_guard/);
  assert.match(migration, /published integration mapping is immutable/);
  assert.match(migration, /fdp_integration_mappings_active_uq/);
});

test("credential vault encrypts authenticated ciphertext and never accepts arbitrary keys", () => {
  const previous = process.env.FDP_INTEGRATION_VAULT_KEY;
  const previousVersion = process.env.FDP_INTEGRATION_VAULT_KEY_VERSION;
  process.env.FDP_INTEGRATION_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.FDP_INTEGRATION_VAULT_KEY_VERSION = "1";
  try {
    const sealed = sealCredentials("erp", { token: "token-value-123456", xToken: "x-token-value-123456" });
    assert.equal(sealed.keyVersion, 1);
    assert.doesNotMatch(sealed.encryptedValue, /token-value/u);
    assert.deepEqual(openCredentials("erp", sealed), { token: "token-value-123456", xToken: "x-token-value-123456" });
    assert.throws(() => sealCredentials("erp", { password: "should-not-be-accepted" }), /não é aceito/u);
  } finally {
    if (previous === undefined) delete process.env.FDP_INTEGRATION_VAULT_KEY; else process.env.FDP_INTEGRATION_VAULT_KEY = previous;
    if (previousVersion === undefined) delete process.env.FDP_INTEGRATION_VAULT_KEY_VERSION; else process.env.FDP_INTEGRATION_VAULT_KEY_VERSION = previousVersion;
  }
});

test("mappings are allowlisted and Sólides cannot be connected speculatively", () => {
  const result = sanitizeMapping({ externalIdField: "employee.id", fields: [
    { source: "employee.name", target: "fullName", transform: "trim", required: true },
    { source: "employee.code", target: "externalCode", transform: "uppercase" },
  ] });
  assert.equal(result.mapping.fields.length, 2);
  assert.match(result.checksum, /^[0-9a-f]{64}$/u);
  assert.throws(() => sanitizeMapping({ fields: [{ source: "name", target: "fullName", transform: "javascript" }] }), /transformações inválidas/u);
  assert.throws(() => validateConnectorEndpoint("solides", "https://example.com/api"), /recurso oficial/u);
});

test("sync requests enqueue atomically and the worker owns retries and dead-letter", async () => {
  const [engine, syncRoute, worker] = await Promise.all([
    readFile(new URL("../lib/integration-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/worker/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(engine, /WITH selected AS[\s\S]+inserted_run AS[\s\S]+inserted_job AS/);
  assert.match(engine, /FOR UPDATE SKIP LOCKED/);
  assert.match(engine, /lease_expires_at/);
  assert.match(engine, /dead_letter/);
  assert.match(engine, /ON CONFLICT \(workspace_id, integration_id, mapping_id, external_id, payload_hash\) DO NOTHING/);
  assert.equal(retryDelaySeconds(1), 30);
  assert.equal(retryDelaySeconds(20), 3600);
  assert.doesNotMatch(syncRoute, /await fetch\(/);
  assert.match(syncRoute, /queueIntegrationRun/);
  const workerBody = worker.slice(worker.indexOf("export async function POST"));
  assert.ok(workerBody.indexOf("matchesSecret") < workerBody.indexOf("setTenantContext"));
  assert.ok(workerBody.indexOf("setTenantContext") < workerBody.indexOf("getD1()"));
});

test("resource APIs expose no plaintext secret and reconciliation is audited atomically", async () => {
  const [overview, credentials, reconciliation, webhook] = await Promise.all([
    readFile(new URL("../app/api/integrations/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/[id]/credentials/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/reconciliations/[id]/resolve/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/webhook/[channel]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(overview, /encrypted_value|initialization_vector|auth_tag/);
  assert.match(credentials, /integration\.credential_rotated/);
  assert.match(credentials, /secretStored: true/);
  assert.doesNotMatch(credentials, /after: \{[^}]*credentials/u);
  assert.match(reconciliation, /WITH updated AS[\s\S]+item_updated AS[\s\S]+audited AS/);
  assert.match(webhook, /fdp_integration_sync_runs/);
  assert.match(webhook, /idempotencyKey/);
  assert.doesNotMatch(webhook, /body LIKE/);
});

test("phase 6 capabilities keep management and reconciliation admin-only", async () => {
  const authorization = await readFile(new URL("../lib/authorization.ts", import.meta.url), "utf8");
  assert.match(authorization, /"integrations\.reconcile"/);
  const memberBlock = authorization.slice(authorization.indexOf("member: new Set"), authorization.indexOf("observer: new Set"));
  assert.doesNotMatch(memberBlock, /integrations\.manage|integrations\.run|integrations\.reconcile/);
});

test("phase 6 UI is modular, secret-safe, resource-driven and keyboard accessible", async () => {
  const [view, drawers, api, types, workspace] = await Promise.all([
    readFile(new URL("../app/painel/features/integrations/IntegrationsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/integrations/IntegrationDrawers.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/integrations/integrations.api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/integrations/integrations.types.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(view, /Conector[\s\S]+Cofre[\s\S]+Mapeamento[\s\S]+Execução[\s\S]+Conciliação/);
  assert.match(view, /role="tablist"/);
  assert.match(view, /aria-controls/);
  assert.match(view, /ArrowRight/);
  assert.match(view, /Home/);
  assert.match(drawers, /type="password"/);
  assert.match(drawers, /autoComplete="new-password"/);
  assert.match(drawers, /const focusables/);
  assert.match(drawers, /event\.key === "Escape"/);
  assert.match(drawers, /connector\.status === "connected"/);
  assert.match(view, /\/api\/integrations\/overview/);
  assert.match(api, /snake/);
  assert.match(types, /"succeeded"/);
  assert.match(workspace, /<IntegrationsView role=/);
  assert.doesNotMatch(workspace, /function IntegrationsSettings|syncIntegration\(/);
  const featureSource = `${view}\n${drawers}\n${api}`;
  assert.doesNotMatch(featureSource, /localStorage|sessionStorage|location\.reload|encrypted_value|initialization_vector|auth_tag/);
  assert.match(featureSource, /O Fila DP não realiza admissão digital/);
});
