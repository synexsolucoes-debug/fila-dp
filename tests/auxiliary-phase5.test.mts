import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { hasCapability } from "../lib/authorization.ts";
import { assertNoClinicalData, sanitizeAuxiliaryPayload } from "../lib/auxiliary.ts";

test("phase 5 tables enforce tenant identity, revision integrity and forced RLS", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0015_auxiliary_modules_foundation.sql", import.meta.url), "utf8"),
  ]);
  for (const table of ["fdp_auxiliary_providers", "fdp_auxiliary_executions", "fdp_auxiliary_execution_revisions", "fdp_auxiliary_approval_steps"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY "fdp_auxiliary_`));
  }
  assert.match(schema, /fdp_auxiliary_approval_execution_revision_fk/);
  assert.match(schema, /fdp_auxiliary_executions_workspace_cycle_fk/);
  assert.match(migration, /submitted auxiliary revision is immutable/);
  assert.match(migration, /invalid auxiliary revision status transition/);
});

test("phase 5 capabilities isolate psychology from observers", () => {
  assert.equal(hasCapability("admin", "psychology.manage"), true);
  assert.equal(hasCapability("member", "psychology.read"), true);
  assert.equal(hasCapability("observer", "psychology.read"), false);
  assert.equal(hasCapability("observer", "benefits.read"), true);
  assert.equal(hasCapability("observer", "contractors.read"), true);
  assert.equal(hasCapability("guest", "benefits.read"), false);
});

test("auxiliary payloads are allowlisted and psychology rejects clinical content", () => {
  const benefits = sanitizeAuxiliaryPayload("benefits", { benefitType: "Saúde", participantsCount: 12, secret: "discard" }, { processedCount: 10, rejectedCount: 2, hidden: "discard" });
  assert.deepEqual(Object.keys(benefits.input), ["benefitType", "action", "participantsCount", "billingReference"]);
  assert.deepEqual(Object.keys(benefits.output), ["processedCount", "rejectedCount", "operatorProtocol", "effectiveDate"]);
  assert.equal(Object.hasOwn(benefits.input, "secret"), false);
  assert.throws(() => sanitizeAuxiliaryPayload("psychology", { sessionsScheduled: 2, clinicalNote: "diagnóstico reservado" }, {}), /Dados clínicos/);
  assert.throws(() => assertNoClinicalData("psychology", "Tratamento individual de paciente"), /Dados clínicos/);
  const psychology = sanitizeAuxiliaryPayload("psychology", { sessionsScheduled: 2, serviceKind: "group" }, { sessionsDelivered: 2, absences: 0 });
  assert.equal(Object.hasOwn(psychology.input, "employeeId"), false);
});

test("auxiliary submission and decisions are assigned, atomic and audit-safe", async () => {
  const [submit, decision, close] = await Promise.all([
    readFile(new URL("../app/api/auxiliary/executions/[id]/submit/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auxiliary/approvals/[id]/decision/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auxiliary/executions/[id]/close/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(submit, /SELF_APPROVAL_FORBIDDEN/);
  assert.match(submit, /company_access/);
  assert.match(submit, /WITH submitted_revision AS/);
  assert.match(decision, /approver_user_id !== user\.id/);
  assert.match(decision, /WITH decided_approval AS/);
  assert.match(decision, /INSERT INTO fdp_audit_events/);
  assert.match(decision, /commentProvided/);
  assert.doesNotMatch(decision, /metadata_json[^\n]+comment/);
  assert.match(close, /WITH updated AS/);
  assert.match(close, /revision\.status = 'approved'/);
});

test("phase 5 uses resource APIs and blocks competence closing until auxiliary delivery", async () => {
  const [overview, executions, transition] = await Promise.all([
    readFile(new URL("../app/api/auxiliary/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auxiliary/executions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/competences/[id]/transition/route.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(overview, /getWorkspaceSnapshot/);
  assert.doesNotMatch(executions, /getWorkspaceSnapshot/);
  assert.match(overview, /privacyBoundary/);
  assert.match(overview, /AS can_decide/);
  assert.match(executions, /inputKeys/);
  assert.match(executions, /outputKeys/);
  assert.match(transition, /fdp_auxiliary_executions/);
  assert.match(transition, /status NOT IN \('closed', 'canceled'\)/);
});

test("phase 5 UI is modular, assigned, privacy-aware and keyboard accessible", async () => {
  const [workspace, view, dialogs] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/auxiliary/AuxiliaryModulesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/auxiliary/AuxiliaryDialogs.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /<AuxiliaryModulesView role=\{snapshot\.workspace\.role\}/);
  assert.match(workspace, /snapshot\.workspace\.role !== "guest"/);
  assert.match(view, /role === "observer" \? \["benefits", "contractors"\]/);
  assert.match(view, /canDecide && item\.canDecide/);
  assert.match(view, /SEM DADOS INDIVIDUAIS/);
  assert.doesNotMatch(view + dialogs, /localStorage|sessionStorage|window\.location\.reload/);
  assert.match(dialogs, /event\.key !== "Tab"/);
  assert.match(dialogs, /previous\?\.focus/);
  assert.match(dialogs, /sessionsScheduled/);
  assert.doesNotMatch(dialogs, /name="employeeId"/);
});
