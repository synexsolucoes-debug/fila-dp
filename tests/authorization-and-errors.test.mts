import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, hasCapability, requireCapability } from "../lib/authorization.ts";
import { ApiError, apiErrorResponse } from "../lib/api-errors.ts";
import { readFile } from "node:fs/promises";

test("RBAC is centralized and denies unknown roles by default", () => {
  for (const capability of capabilities) assert.equal(hasCapability("admin", capability), true);
  assert.equal(hasCapability("owner-from-untrusted-database", "workspace.manage"), false);
  assert.equal(hasCapability("member", "integrations.run"), false);
  assert.equal(hasCapability("member", "hr.write"), true);
  assert.equal(hasCapability("observer", "cards.write"), false);
  assert.equal(hasCapability("guest", "comments.write"), true);
  assert.equal(hasCapability("guest", "hr.read"), false);
});

test("missing capabilities produce a stable public forbidden error", () => {
  assert.throws(
    () => requireCapability("member", "integrations.run"),
    (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === "CAPABILITY_REQUIRED",
  );
});

test("api errors expose expected messages and redact unexpected failures", async () => {
  const expected = apiErrorResponse(ApiError.notFound("Registro não encontrado.", "RECORD_NOT_FOUND"));
  assert.equal(expected.status, 404);
  assert.deepEqual(await expected.json(), { error: "Registro não encontrado.", code: "RECORD_NOT_FOUND" });

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const unexpected = apiErrorResponse(new Error("postgres password=super-secret constraint details"));
    assert.equal(unexpected.status, 500);
    const body = await unexpected.json() as Record<string, unknown>;
    assert.equal(body.code, "INTERNAL_ERROR");
    assert.equal(String(body.error).includes("super-secret"), false);
    assert.match(String(body.requestId), /^[0-9a-f-]{36}$/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("structured audit is tenant-scoped, append-only and admin-readable", async () => {
  const [migration, schema, route, memberRoute] = await Promise.all([
    readFile(new URL("../drizzle/postgres/0012_structured_audit.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/audit/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /fdp_audit_events/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /fdp_audit_events_append_only/);
  assert.match(migration, /ON DELETE RESTRICT/);
  assert.match(route, /requireCapability\(workspace, "audit\.read"\)/);
  assert.match(route, /workspace_id = \?/);
  assert.match(memberRoute, /prepareAuditEvent/);
  assert.ok(memberRoute.indexOf("prepareAuditEvent") < memberRoute.indexOf("await d1.batch(statements)"));
});
