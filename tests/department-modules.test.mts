import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { areaModuleList } from "../lib/areas.ts";
import { resolveModules } from "../lib/modules.ts";

test("departamentos aceitam módulos do catálogo sem perder o roteamento SESMT e DP", () => {
  assert.deepEqual(
    areaModuleList(["epi", "registrations", "epi.owner", "epi.discount_analysis", "epi"], ["epi", "registrations"]),
    ["epi", "registrations", "epi.owner", "epi.discount_analysis"],
  );
  assert.throws(
    () => areaModuleList(["modulo-inventado"], ["epi"]),
    /Roteamento de módulo inválido/u,
  );
});

test("API entrega o catálogo real e valida as chaves antes de persistir", async () => {
  const [collection, detail] = await Promise.all([
    readFile(new URL("../app/api/areas/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/areas/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(collection, /getWorkspaceModules\(d1, workspace\.id, "admin"/u);
  assert.match(collection, /modules: modules\.map/u);
  for (const source of [collection, detail]) {
    assert.match(source, /SELECT key FROM fdp_modules/u);
    assert.match(source, /areaModuleList\(body\.moduleKeys, catalog\.results/u);
  }
});

test("tela separa módulos do departamento do roteamento operacional", async () => {
  const [panel, registrations] = await Promise.all([
    readFile(new URL("../app/painel/features/registrations/AreasPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(registrations, /Departamentos e módulos/u);
  assert.match(panel, /Módulos do departamento/u);
  assert.match(panel, /name="departmentModules" value=\{module\.key\}/u);
  assert.match(panel, /Roteamento SESMT → DP/u);
});

test("SESMT existente recebe o módulo de EPI sem sobrescrever associação manual", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0046_department_module_backfill.sql", import.meta.url), "utf8");
  assert.match(migration, /SELECT "workspace_id", 'epi', "area_id", "created_by"/u);
  assert.match(migration, /WHERE "module_key" = 'epi\.owner'/u);
  assert.match(migration, /ON CONFLICT \("workspace_id", "module_key"\) DO NOTHING/u);
});

const accessCatalog = [
  {
    key: "payroll", name: "Folha", description: "", category: "folha" as const, route: "payroll",
    requiredCapability: "hr.read", dependsOn: "", status: "active" as const, position: 100,
  },
  {
    key: "board", name: "Demandas", description: "", category: "operacao" as const, route: "board",
    requiredCapability: "cards.read", dependsOn: "", status: "active" as const, position: 200,
  },
];

const accessBase = {
  modules: accessCatalog,
  planModules: new Set(["payroll", "board"]),
  workspaceGrants: new Map<string, boolean>(),
  workspaceStatus: "active",
  subscriptionStatus: "active",
};

test("departamento é o limite máximo mesmo diante de liberação individual antiga", () => {
  const modules = resolveModules({
    ...accessBase,
    role: "admin",
    departmentModules: new Set(["payroll"]),
    memberGrants: new Map([["board", true]]),
  });
  assert.equal(modules.find((item) => item.key === "payroll")?.allowed, true);
  const board = modules.find((item) => item.key === "board");
  assert.equal(board?.allowed, false);
  assert.equal(board?.reason, "not_in_department");
});

test("módulo do departamento ainda exige decisão individual ou papel compatível", () => {
  const inherited = resolveModules({ ...accessBase, role: "guest", departmentModules: new Set(["payroll"]) });
  assert.equal(inherited.find((item) => item.key === "payroll")?.allowed, false);
  assert.equal(inherited.find((item) => item.key === "payroll")?.reason, "missing_capability");

  const approved = resolveModules({
    ...accessBase,
    role: "guest",
    departmentModules: new Set(["payroll"]),
    memberGrants: new Map([["payroll", true]]),
  });
  assert.equal(approved.find((item) => item.key === "payroll")?.allowed, true);
});

test("criação e alteração persistem departamento e módulos no mesmo fluxo", async () => {
  const [create, update, helper, screen] = await Promise.all([
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/member-departments.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(create, /resolveMemberDepartmentAccess/u);
  assert.match(create, /body\.departmentId/u);
  assert.match(update, /prepareMemberDepartmentAccess/u);
  assert.match(helper, /MEMBER_DEPARTMENT_REQUIRED/u);
  assert.match(helper, /MEMBER_MODULE_OUTSIDE_DEPARTMENT/u);
  assert.match(helper, /is_primary = 0/u);
  assert.match(helper, /fdp_member_module_grants/u);
  assert.match(screen, /departmentId: memberDepartmentId/u);
  assert.match(screen, /Workspace → Departamento → Módulos/u);
  assert.match(screen, /Departamento principal/u);
  assert.match(screen, /Módulos liberados neste departamento/u);
});

test("a API individual impede liberar módulo de outro departamento", async () => {
  const route = await readFile(new URL("../app/api/members/[id]/modules/route.ts", import.meta.url), "utf8");
  assert.match(route, /MODULE_OUTSIDE_DEPARTMENT/u);
  assert.match(route, /MODULE_DECISION_REQUIRED/u);
  assert.match(route, /departmentModules/u);
});

test("lotação também é protegida quando alterada pelo cadastro do departamento", async () => {
  const [members, department] = await Promise.all([
    readFile(new URL("../app/api/areas/[id]/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/areas/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(members, /MEMBER_PRIMARY_DEPARTMENT_REQUIRED/u);
  assert.match(members, /Acesso definido pela lotação no departamento/u);
  assert.match(department, /DEPARTMENT_HAS_PRIMARY_MEMBERS/u);
});
