import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { areaModuleList } from "../lib/areas.ts";
import { mergeDepartmentAndMemberGrants, resolveModules } from "../lib/modules.ts";

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

test("plataforma administrativa separa módulos do departamento do roteamento operacional", async () => {
  const [platform, registrations] = await Promise.all([
    readFile(new URL("../app/plataforma/features/WorkspaceConfiguration.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(platform, /Áreas operacionais e módulos/u);
  assert.match(platform, /Módulos do departamento/u);
  assert.match(platform, /name="departmentModules"/u);
  assert.match(platform, /Roteamento SESMT → DP/u);
  assert.match(platform, /Plataforma → Operações → Workspace → Acessos e módulos/u);
  assert.doesNotMatch(registrations, /AreasPanel|setTab\("areas"\)|Departamentos e módulos/u);
});

test("somente a Plataforma administra áreas; o painel conserva leitura para os cadastros de usuário", async () => {
  const [collection, detail, members, platform] = await Promise.all([
    readFile(new URL("../app/api/areas/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/areas/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/areas/[id]/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/workspaces/[id]/configuration/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(collection, /export async function GET[\s\S]+export async function POST[\s\S]+requirePlatformAdmin\(auth\.user\)/u);
  assert.match(detail, /export async function PATCH[\s\S]+requirePlatformAdmin\(auth\.user\)[\s\S]+export async function DELETE[\s\S]+requirePlatformAdmin\(auth\.user\)/u);
  assert.match(members, /export async function PUT[\s\S]+requirePlatformAdmin\(auth\.user\)/u);
  assert.match(platform, /action === "area\.save"/u);
  assert.match(platform, /action === "area\.archive"/u);
  assert.match(platform, /resolveMemberDepartmentAccess/u);
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

/**
 * O departamento é padrão, não teto.
 *
 * Este par de testes já disse o contrário. A regra anterior — departamento
 * acima da exceção individual — tornava impossível dar a uma pessoa o acesso
 * que a área dela não tem, e era exatamente esse o pedido que chegava de quem
 * administra o grupo. A tela de módulos por usuário existia e não conseguia
 * fazer a única coisa para a qual serve.
 *
 * A inversão precisa ser provada **nas duas direções** no mesmo lugar: liberar
 * fora do departamento e bloquear dentro dele. Testar só a direção nova deixaria
 * passar a correção que abre demais.
 */
test("exceção individual abre módulo fora do departamento", () => {
  const modules = resolveModules({
    ...accessBase,
    role: "admin",
    departmentModules: new Set(["payroll"]),
    memberGrants: new Map([["board", true]]),
  });
  assert.equal(modules.find((item) => item.key === "payroll")?.allowed, true);
  const board = modules.find((item) => item.key === "board");
  assert.equal(board?.allowed, true, "a liberação nominal deve vencer o departamento");
  assert.equal(board?.reason, "ok");
});

test("exceção individual fecha módulo que o departamento daria", () => {
  const modules = resolveModules({
    ...accessBase,
    role: "admin",
    departmentModules: new Set(["payroll", "board"]),
    memberGrants: new Map([["payroll", false]]),
  });
  const payroll = modules.find((item) => item.key === "payroll");
  assert.equal(payroll?.allowed, false);
  assert.equal(payroll?.reason, "denied_for_member");
  assert.equal(modules.find((item) => item.key === "board")?.allowed, true);
});

test("sem exceção, quem manda continua sendo o departamento", () => {
  // A parte que **não** mudou, e que a inversão poderia ter derrubado junto:
  // um módulo que ninguém decidiu à mão segue o que a área dá.
  const modules = resolveModules({
    ...accessBase,
    role: "admin",
    departmentModules: new Set(["payroll"]),
    memberGrants: new Map(),
  });
  assert.equal(modules.find((item) => item.key === "payroll")?.allowed, true);
  const board = modules.find((item) => item.key === "board");
  assert.equal(board?.allowed, false);
  assert.equal(board?.reason, "not_in_department");
});

test("o plano continua acima da exceção individual", () => {
  // O limite que sobreviveu à inversão: liberar para uma pessoa o que o grupo
  // não contratou seria vender por dentro da tela de permissões.
  const modules = resolveModules({
    ...accessBase,
    planModules: new Set(["payroll"]),
    role: "admin",
    departmentModules: new Set(["payroll"]),
    memberGrants: new Map([["board", true]]),
  });
  const board = modules.find((item) => item.key === "board");
  assert.equal(board?.allowed, false);
  assert.equal(board?.reason, "not_in_plan");
});

test("a junção de departamento e exceção segue a mesma regra da resolução", () => {
  // Duas implementações leem a mesma decisão: `resolveModuleAccess` monta o
  // menu e `mergeDepartmentAndMemberGrants` monta as capacidades. Divergirem é
  // como um módulo aparece no menu e devolve 403 ao ser aberto.
  const merged = mergeDepartmentAndMemberGrants(
    ["payroll", "board", "epi"],
    new Map([["board", true], ["payroll", false]]),
    new Set(["payroll"]),
  );
  assert.equal(merged.get("board"), true, "exceção fora do departamento continua liberada");
  assert.equal(merged.get("payroll"), false, "exceção contra o departamento continua bloqueada");
  assert.equal(merged.get("epi"), false, "sem exceção, fora do departamento segue negado");

  // Sem departamento principal não há padrão a aplicar: só valem as exceções.
  const semDepartamento = mergeDepartmentAndMemberGrants(["payroll", "board"], new Map([["board", true]]), undefined);
  assert.deepEqual([...semDepartamento], [["board", true]]);
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
  // A porta de "Usuários e acessos" agora nasce de `settingsNavGroups`; o
  // desenho do botão é conferido em `settings-scope.test.mts`, aqui basta que a
  // seção exista e continue exigindo administrador.
  assert.match(screen, /\{ section: "team", icon: Users, hint: "Departamento e módulos" \}/u);
  assert.match(screen, /title: "Usuários e acessos"/u);
  assert.match(screen, /Departamento principal/u);
  assert.match(screen, /Módulos liberados neste departamento/u);
});

test("a API individual libera módulo fora do departamento e ainda para no plano", async () => {
  const [route, screen] = await Promise.all([
    readFile(new URL("../app/api/members/[id]/modules/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/shared/MemberModules.tsx", import.meta.url), "utf8"),
  ]);
  // As três recusas que faziam do departamento um teto saíram; se voltarem, a
  // tela volta a não conseguir fazer aquilo para que existe.
  for (const recusa of ["MODULE_OUTSIDE_DEPARTMENT", "MODULE_DECISION_REQUIRED", "MEMBER_DEPARTMENT_REQUIRED"]) {
    assert.doesNotMatch(route, new RegExp(recusa, "u"),
      `${recusa} voltou: o departamento voltou a ser teto em vez de padrão`);
  }
  // As duas que continuam, e por motivos diferentes: contrato e recuperação.
  assert.match(route, /MODULE_NOT_CONTRACTED/u);
  assert.match(route, /SELF_LOCKOUT/u);
  // E a tela precisa oferecer o botão, senão a API aberta não serve para nada.
  assert.doesNotMatch(screen, /Defina o departamento principal deste usuário antes de alterar os módulos/u);
  assert.match(screen, /Liberado por exceção para esta pessoa/u);
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
