import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ExcelJS from "exceljs";
import { hasCapability } from "../lib/authorization.ts";
import { protectCpf } from "../lib/registrations.ts";
import { readSankhyaEmployeeWorkbook } from "../lib/sankhya-xlsx.ts";

test("phase 3 registration tables are tenant-scoped and forced through RLS", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0013_registrations_foundation.sql", import.meta.url), "utf8"),
  ]);
  for (const table of ["departments", "positions", "costCenters", "workSchedules", "employees"]) {
    assert.match(schema, new RegExp(`export const ${table} = pgTable`));
  }
  for (const table of ["fdp_departments", "fdp_positions", "fdp_cost_centers", "fdp_work_schedules", "fdp_employees"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY "${table}_workspace_isolation"`));
  }
  assert.match(migration, /fdp_employees_workspace_company_fk/);
  assert.match(migration, /fdp_employees_workspace_cpf_hash_uq/);
});

test("employee capabilities are explicit and default-deny", () => {
  assert.equal(hasCapability("admin", "companies.manage"), true);
  assert.equal(hasCapability("member", "employees.manage"), true);
  assert.equal(hasCapability("observer", "employees.read"), true);
  assert.equal(hasCapability("observer", "employees.manage"), false);
  assert.equal(hasCapability("guest", "employees.read"), false);
});

test("CPF protection validates, hashes deterministically and never returns raw CPF", () => {
  const previous = process.env.FDP_PII_HASH_SECRET;
  process.env.FDP_PII_HASH_SECRET = "phase-three-test-secret";
  try {
    const first = protectCpf("529.982.247-25");
    const second = protectCpf("52998224725");
    assert.equal(first.cpfHash, second.cpfHash);
    assert.equal(first.cpfLast4, "4725");
    assert.equal(JSON.stringify(first).includes("52998224725"), false);
    assert.throws(() => protectCpf("111.111.111-11"));
  } finally {
    if (previous === undefined) delete process.env.FDP_PII_HASH_SECRET;
    else process.env.FDP_PII_HASH_SECRET = previous;
  }
});

test("employee resource APIs apply company scope, capability checks and structured audit", async () => {
  const [collection, detail, history, catalog, dbSource] = await Promise.all([
    readFile(new URL("../app/api/employees/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employees/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employees/[id]/history/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/registrations/catalogs/[resource]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
  ]);
  assert.match(collection, /requireCapability\(workspace, "employees\.read"\)/);
  assert.match(collection, /requireCompanyAccess/);
  assert.match(collection, /prepareAuditEvent/);
  assert.match(detail, /requireCompanyAccess/);
  assert.match(history, /entity_type = 'employee'/);
  assert.match(catalog, /getCatalogResource/);
  assert.match(dbSource, /sensitiveAuditKey = .*cpf/i);
  const snapshotBody = dbSource.slice(dbSource.indexOf("export async function getWorkspaceSnapshot"), dbSource.indexOf("export async function getWorkspaceSnapshot") + 12000);
  assert.doesNotMatch(snapshotBody, /fdp_employees/);
});

test("company deletion is implemented as audited inactivation", async () => {
  const source = await readFile(new URL("../app/api/companies/[id]/route.ts", import.meta.url), "utf8");
  assert.match(source, /SET status = 'inactive'/);
  assert.match(source, /company\.inactivated/);
  assert.doesNotMatch(source, /DELETE FROM fdp_companies/);
});

test("registration UI uses server search, async refresh and role-aware navigation", async () => {
  const [view, workspace] = await Promise.all([
    readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(view, /params\.set\("search", employeeSearchQuery\)/);
  assert.match(view, /onRefresh=\{loadCompanies\}/);
  assert.doesNotMatch(view, /window\.location\.reload/);
  assert.match(view, /item\.isPrincipal/);
  // Convidado não vê Cadastros. A regra virou dado no catálogo de telas.
  assert.match(workspace, /module: "registrations", hiddenFor: \["guest"\]/u);
});

test("Sankhya workbook reader maps the minimal employee connector fields", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Resultado da Query");
  sheet.addRow(["Relatório Sankhya"]);
  sheet.addRow([]);
  sheet.addRow(["CODEMP", "CODFUNC", "NOMEFUNC", "CPF", "DTADM", "MATRICULA", "DTNASC", "DTDEM", "EMAILCORP", "CELULAR"]);
  sheet.addRow([40, 123, "Colaborador Exemplo", "52998224725", "01/08/2026", "MAT-123", "10/05/1990", "", "pessoa@empresa.test", "11999999999"]);
  const buffer = await workbook.xlsx.writeBuffer();
  const records = await readSankhyaEmployeeWorkbook(buffer as unknown as ArrayBuffer);
  assert.deepEqual(records, [{
    companyCode: "40", employeeCode: "123", registrationNumber: "MAT-123", fullName: "Colaborador Exemplo",
    cpf: "52998224725", birthDate: "1990-05-10", admissionDate: "2026-08-01", terminationDate: "",
    email: "pessoa@empresa.test", phone: "11999999999", externalId: "40:123",
  }]);
});

test("Sankhya import, dismissal and guarded deletion are exposed in the employee workflow", async () => {
  const [importRoute, terminateRoute, employeeRoute, view, dialog] = await Promise.all([
    readFile(new URL("../app/api/employees/import/sankhya/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employees/[id]/terminate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employees/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/registrations/SankhyaImportDialog.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(importRoute, /classification: "conflict"/u);
  assert.match(importRoute, /source_system, external_id/u);
  assert.match(importRoute, /employees\.sankhya_imported/u);
  assert.match(terminateRoute, /employment_status = 'terminated'/u);
  assert.match(terminateRoute, /employee\.terminated/u);
  assert.match(employeeRoute, /EMPLOYEE_HAS_HISTORY/u);
  assert.match(employeeRoute, /fdp_epi_discount_requests/u);
  assert.match(view, /Importar Sankhya/u);
  assert.match(view, /Confirmar demissão/u);
  assert.match(dialog, /Nenhuma alteração foi gravada ainda/u);
  assert.doesNotMatch(dialog, /record\.cpf[^L]/u);
});
