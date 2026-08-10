import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { toPostgresParameters } from "../lib/postgres-parameters.ts";
import { getEnabledFeatureFlags } from "../lib/feature-flags.ts";

test("converte apenas placeholders fora de textos SQL", () => {
  assert.equal(
    toPostgresParameters("SELECT '?' AS literal, id FROM x WHERE a = ? AND b = ?"),
    "SELECT '?' AS literal, id FROM x WHERE a = $1 AND b = $2",
  );
});

test("flags sensíveis permanecem desligadas em produção sem autorização adicional", () => {
  const flags = getEnabledFeatureFlags({
    NODE_ENV: "production",
    FDP_FEATURE_FLAGS: "aiBoardOrchestration,erpWriteback,automaticSensitiveChanges",
    FDP_ALLOW_SENSITIVE_FEATURES: "false",
  });
  assert.deepEqual([...flags], ["aiBoardOrchestration"]);
});

test("rotas não inicializam schema nem traduzem dialeto SQLite", async () => {
  const database = await readFile(new URL("../db/index.ts", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.doesNotMatch(database, /PRAGMA|INSERT\s+OR\s+IGNORE|datetime\s*\(/i);
  assert.doesNotMatch(workspace, /CREATE\s+TABLE|ensureSchema|PRAGMA/i);
});

test("token de recuperação mantém a autoria exigida pela API", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/postgres/0002_chief_venom.sql", import.meta.url), "utf8");
  assert.match(schema, /createdBy:\s*text\("created_by"\)\.notNull\(\)/);
  assert.match(migration, /ADD COLUMN "created_by" text DEFAULT 'system' NOT NULL/);
});

test("legacy timestamp defaults are bridged around the type conversion", async () => {
  const prepare = await readFile(new URL("../drizzle/postgres/0001_0_prepare_legacy_defaults.sql", import.meta.url), "utf8");
  const normalize = await readFile(new URL("../drizzle/postgres/0001_normalize_existing_neon.sql", import.meta.url), "utf8");
  const restore = await readFile(new URL("../drizzle/postgres/0001_z_restore_timestamp_defaults.sql", import.meta.url), "utf8");
  assert.match(prepare, /ALTER COLUMN "created_at" DROP DEFAULT/);
  assert.match(normalize, /ALTER COLUMN "created_at" TYPE timestamptz/);
  assert.match(restore, /ALTER COLUMN "created_at" SET DEFAULT now\(\)/);
  assert.ok("0001_0_prepare_legacy_defaults.sql" < "0001_normalize_existing_neon.sql");
  assert.ok("0001_normalize_existing_neon.sql" < "0001_z_restore_timestamp_defaults.sql");
});

test("the legacy recovery author column is normalized instead of recreated", async () => {
  const migrator = await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(migrator, /file === "0002_chief_venom\.sql"/);
  assert.match(migrator, /ALTER COLUMN created_by SET DEFAULT 'system'/);
  assert.match(migrator, /normalized-existing-column/);
});

test("migration checksums ignore only line endings and final whitespace", async () => {
  const migrator = await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(migrator, /replace\(\/\\r\\n\/g, "\\n"\)\.trimEnd\(\)/);
  assert.match(migrator, /compatibleChecksums/);
});

test("legacy auth rate limits are normalized before later migrations", async () => {
  const migrationRunner = await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(migrationRunner, /0004_auth_rate_limits\.sql/);
  assert.match(migrationRunner, /normalized-existing-table/);
  assert.match(migrationRunner, /information_schema\.columns/);
  assert.match(migrationRunner, /fdp_auth_rate_limits_blocked_idx/);
  assert.match(migrationRunner, /RENAME COLUMN \"attempt_count\" TO \"failure_count\"/);
});

test("legacy board process snapshots are preserved before the operations schema", async () => {
  const migrationRunner = await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(migrationRunner, /0014_operation_dp_foundation\.sql/);
  assert.match(migrationRunner, /fdp_legacy_board_process_versions/);
  assert.match(migrationRunner, /ALTER TABLE \"fdp_process_versions\" RENAME TO/);
  assert.match(migrationRunner, /legacyShape/);
  assert.match(migrationRunner, /uniqueIndexes/);
  assert.match(migrationRunner, /firstForeignKey/);
});

test("authentication sessions are opaque, persisted and revocable", async () => {
  const [schema, auth, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chatgpt-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0003_revocable_sessions_and_solides_boundary.sql", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /fdp_auth_sessions/);
  assert.match(auth, /randomBytes\(32\)/);
  assert.match(auth, /revoked_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(auth, /type SessionPayload/);
  assert.match(migration, /CREATE TABLE "fdp_auth_sessions"/);
});

test("users can inspect and revoke only their own persisted sessions", async () => {
  const [schema, auth, login, sessions, sessionById, reset, migration, dashboard] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chatgpt-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/sessions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/sessions/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/reset/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0011_session_management.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /deviceLabel:\s*text\("device_label"\)/);
  assert.match(schema, /ipHash:\s*text\("ip_hash"\)/);
  assert.match(auth, /sessionId\?: string/);
  assert.match(auth, /SESSION_TOUCH_INTERVAL_MS/);
  assert.match(auth, /session-address:/);
  assert.match(login, /userAgent: request\.headers\.get\("user-agent"\)/);
  assert.match(sessions, /WHERE user_id = \?/);
  assert.match(sessions, /id <> \?/);
  assert.match(sessionById, /WHERE id = \? AND user_id = \?/);
  assert.match(reset, /UPDATE fdp_auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = \?/);
  assert.match(migration, /ADD COLUMN "device_label"/);
  assert.match(migration, /ADD COLUMN "ip_hash"/);
  assert.doesNotMatch(sessions, /ip_hash/);
  assert.match(dashboard, /Dispositivos conectados/);
  assert.match(dashboard, /scope=others/);
  assert.match(dashboard, /scope=all/);
});

test("login throttling is persistent and keyed without storing raw identifiers", async () => {
  const [schema, limiter, login, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth-rate-limit.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0004_auth_rate_limits.sql", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /fdp_auth_rate_limits/);
  assert.match(limiter, /createHmac\("sha256"/);
  assert.match(limiter, /ON CONFLICT \(key_hash\) DO UPDATE/);
  assert.match(login, /status: 429/);
  assert.match(login, /Retry-After/);
  assert.match(migration, /CREATE TABLE "fdp_auth_rate_limits"/);
});

test("tenant relationships are enforced by composite database constraints", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0005_tenant_integrity_constraints.sql", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(schema, /fdp_workspaces_owner_uq/);
  assert.match(schema, /fdp_workspaces_owner_idx/);
  assert.match(schema, /fdp_member_company_access_member_fk/);
  assert.match(schema, /fdp_member_company_access_company_fk/);
  assert.match(schema, /fdp_hr_metrics_workspace_company_fk/);
  assert.match(migration, /DROP INDEX IF EXISTS "fdp_workspaces_owner_uq"/);
  assert.match(migration, /tenant integrity preflight failed/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "fdp_companies_workspace_id_uq"/);
  assert.match(migration, /FOREIGN KEY \("workspace_id", "company_id"\)/);
});

test("bootstrap and redirects have race and open-redirect defenses", async () => {
  const [auth, login, logout, limiter, migration] = await Promise.all([
    readFile(new URL("../app/chatgpt-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/logout/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth-rate-limit.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0006_bootstrap_guard.sql", import.meta.url), "utf8"),
  ]);
  assert.match(auth, /export function safeRelativeReturnPath/);
  assert.match(login, /fdp_bootstrap_guard/);
  assert.match(login, /owner_user_id = \?/);
  assert.match(logout, /safeRelativeReturnPath/);
  assert.match(limiter, /process\.env\.VERCEL/);
  assert.match(migration, /fdp_bootstrap_guard_singleton_ck/);
  assert.doesNotMatch(logout, /export async function GET/);
  assert.match(logout, /export async function POST/);
});

test("a conexão devolvida ao pedido carrega o tenant, sem depender de contexto assíncrono", async () => {
  const [database, adapter] = await Promise.all([
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/index.ts", import.meta.url), "utf8"),
  ]);
  // O contexto por AsyncLocalStorage não sobrevive ao retorno de uma função async:
  // quem chama volta ao contexto anterior. Depender só dele deixava as consultas
  // da rota sem app.workspace_id — e, com RLS, sem nenhuma linha.
  assert.match(database, /const scopedD1 = getScopedD1\(tenant\)/);
  assert.match(database, /return \{ d1: scopedD1,/);
  assert.match(adapter, /export function getScopedD1\(context: TenantContext\): D1Database/);
  assert.match(adapter, /this\.boundContext \?\? getTenantContext\(\)/);
  assert.match(adapter, /set_config\('app\.workspace_id'/);
  assert.match(adapter, /set_config\('app\.user_id'/);
  // Auditoria e atividade também gravam pela conexão com tenant explícito.
  assert.match(database, /getScopedD1\(tenantWorkspaceGuard\(input\.workspaceId\)\)/);
  assert.match(database, /getScopedD1\(tenantWorkspaceGuard\(workspaceId\)\)/);
});

test("the first RLS pilot denies company access without tenant context", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0007_companies_rls.sql", import.meta.url), "utf8");
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /current_setting\('app\.workspace_id', true\)/);
  assert.match(migration, /WITH CHECK/);
});

test("direct workspace tables are only enabled after bootstrap context is available", async () => {
  const [migration, login] = await Promise.all([
    readFile(new URL("../drizzle/postgres/0008_direct_workspace_rls.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /fdp_hr_metrics_workspace_isolation/);
  assert.match(migration, /fdp_labels_workspace_isolation/);
  assert.match(migration, /fdp_automation_rules_workspace_isolation/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(login, /setTenantContext\(\{ workspaceId, userId \}\)/);
});

test("signed webhooks establish tenant context before protected writes", async () => {
  const [webhook, migration] = await Promise.all([
    readFile(new URL("../app/api/integrations/webhook/[channel]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0009_webhook_tenant_rls.sql", import.meta.url), "utf8"),
  ]);
  assert.ok(webhook.indexOf("preAuthExpectedSecret") < webhook.indexOf("const d1 = getD1()"));
  assert.match(webhook, /preAuthSecretKey}_WORKSPACE_ID/);
  assert.ok(webhook.indexOf("setTenantContext({ workspaceId") < webhook.indexOf("const d1 = getD1()"));
  assert.match(migration, /fdp_integrations_workspace_isolation/);
  assert.match(migration, /fdp_workspace_inbox_items_workspace_isolation/);
  assert.match(migration, /fdp_activity_events_workspace_isolation/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
});

test("Sólides remains an external source instead of an admission workflow", async () => {
  const [database, api, dashboard, landing, migration] = await Promise.all([
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/fila-dp-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0003_revocable_sessions_and_solides_boundary.sql", import.meta.url), "utf8"),
  ]);
  assert.match(database, /\["solides", "Sólides"\]/);
  assert.match(database, /Conciliação de colaborador admitido/);
  assert.match(api, /Processo de admissão inválido/);
  assert.match(dashboard, /A admissão digital permanece integralmente na Sólides/);
  assert.match(landing, /A admissão digital continua integralmente na Sólides/);
  assert.match(migration, /'solides', 'Sólides', 'needs_credentials'/);
});
