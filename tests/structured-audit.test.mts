import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("structured audit is tenant-isolated, append-only, and durable", async () => {
  const [migration, schema, database] = await Promise.all([
    readFile(new URL("../drizzle/postgres/0012_structured_audit.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE "fdp_audit_events"/);
  assert.match(migration, /ON DELETE RESTRICT/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /fdp_audit_events_append_only/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(schema, /export const auditEvents = pgTable\("fdp_audit_events"/);
  assert.match(schema, /beforeJson: jsonb/);
  assert.match(database, /sensitiveAuditKey/);
  assert.match(database, /prepareAuditEvent/);
});

test("member authorization changes batch mutation, timeline, and audit together", async () => {
  const route = await readFile(new URL("../app/api/members/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireCapability\(workspace, "members\.manage"\)/);
  assert.match(route, /prepareActivity/);
  assert.match(route, /prepareAuditEvent/);
  assert.match(route, /await d1\.batch\(statements\)/);
  assert.ok(route.indexOf("validCompanies.results.length") < route.indexOf("UPDATE fdp_workspace_members"));
});

test("sensitive snapshot projections and integration execution use capabilities", async () => {
  const [database, sync] = await Promise.all([
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/sync/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(database, /canManageMembers/);
  assert.match(database, /canManageIntegrations/);
  assert.match(database, /hrMetrics: canReadHr \?/);
  assert.match(sync, /requireCapability\(workspace, "integrations\.run"\)/);
});
