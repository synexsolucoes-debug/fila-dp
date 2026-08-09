import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasCapability } from "../lib/authorization.ts";
import { assertNoAdmissionWorkflow, sanitizeMovementDetails, sanitizeProcessConfiguration, validCompetence } from "../lib/operations.ts";

test("phase 4 domain tables are tenant-scoped with composite integrity and forced RLS", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0014_operation_dp_foundation.sql", import.meta.url), "utf8"),
  ]);
  for (const declaration of ["payrollCycles", "employeeMovements", "movementApprovalSteps", "payrollCycleItems", "complianceObligations", "operationalPendingItems", "processDefinitions", "processVersions"]) {
    assert.match(schema, new RegExp(`export const ${declaration} = pgTable`));
  }
  for (const table of ["fdp_payroll_cycles", "fdp_employee_movements", "fdp_movement_approval_steps", "fdp_payroll_cycle_items", "fdp_compliance_obligations", "fdp_operational_pending_items", "fdp_process_definitions", "fdp_process_versions"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`));
  }
  assert.match(migration, /fdp_employee_movements_workspace_employee_fk/);
  assert.match(migration, /fdp_operational_pending_items_workspace_key_uq/);
  assert.match(migration, /fdp_process_versions_immutable_published/);
  assert.match(migration, /published process versions are immutable/);
});

test("phase 4 capabilities separate operations, decisions and publishing", () => {
  assert.equal(hasCapability("admin", "processes.publish"), true);
  assert.equal(hasCapability("member", "movements.manage"), true);
  assert.equal(hasCapability("member", "approvals.decide"), true);
  assert.equal(hasCapability("member", "processes.publish"), false);
  assert.equal(hasCapability("observer", "competences.read"), true);
  assert.equal(hasCapability("observer", "movements.read"), false);
  assert.equal(hasCapability("guest", "competences.read"), false);
});

test("movement and process payloads use allowlists and preserve the Sólides boundary", () => {
  const details = sanitizeMovementDetails("salary_change", { reason: "Mérito", percentage: 8, newSalary: 5000, diagnosis: "must-not-pass", rawPayload: { secret: true } });
  assert.deepEqual(Object.keys(details).sort(), ["newSalary", "percentage", "reason"]);
  assert.equal(JSON.stringify(details).includes("diagnosis"), false);
  const configuration = sanitizeProcessConfiguration({ steps: [{ key: "triage", name: "Triagem", gate: true }], transitions: [], arbitrary: "drop" });
  assert.deepEqual(Object.keys(configuration).sort(), ["approvalRequired", "checklist", "steps", "transitions"]);
  assert.equal(validCompetence("2026-08"), "2026-08");
  assert.throws(() => validCompetence("2026-13"));
  assert.throws(() => assertNoAdmissionWorkflow("Admissão digital"));
  assert.doesNotThrow(() => assertNoAdmissionWorkflow("Conciliação cadastral Sólides"));
});

test("competence transition enforces gates atomically and writes audit in the same statement", async () => {
  const source = await readFile(new URL("../app/api/operations/competences/[id]/transition/route.ts", import.meta.url), "utf8");
  assert.match(source, /WITH updated AS/);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM fdp_operational_pending_items/);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM fdp_employee_movements/);
  assert.match(source, /INSERT INTO fdp_audit_events/);
  assert.match(source, /competences\.reopen/);
  assert.match(source, /REOPEN_REASON_REQUIRED/);
});

test("approvals require assignment, company scope and reject sensitive self-approval", async () => {
  const [submit, decision, overview, operationsView] = await Promise.all([
    readFile(new URL("../app/api/operations/movements/[id]/submit/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/approvals/[id]/decision/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/operations/OperationsView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(submit, /SELF_APPROVAL_FORBIDDEN/);
  assert.match(submit, /company_access/);
  assert.match(decision, /approver_user_id !== user\.id/);
  assert.match(decision, /requireCompanyAccess/);
  assert.match(decision, /SELF_APPROVAL_FORBIDDEN/);
  assert.match(decision, /WITH decided_approval AS/);
  assert.match(decision, /INSERT INTO fdp_audit_events/);
  assert.match(decision, /AND a\.status = 'pending'/);
  assert.match(overview, /AS can_decide/);
  assert.match(operationsView, /canDecide && item\.canDecide/);
});

test("phase 4 APIs return resources instead of expanding WorkspaceSnapshot", async () => {
  const files = [
    "../app/api/operations/overview/route.ts", "../app/api/operations/competences/route.ts", "../app/api/operations/movements/route.ts",
    "../app/api/operations/obligations/route.ts", "../app/api/operations/pending-items/route.ts", "../app/api/operations/processes/route.ts",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /getWorkspaceSnapshot/);
  }
  const cards = await readFile(new URL("../app/api/cards/route.ts", import.meta.url), "utf8");
  assert.match(cards, /competence, legal_due_at, process_template_id/);
});
