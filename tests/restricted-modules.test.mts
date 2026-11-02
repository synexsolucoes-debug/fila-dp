import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { capabilitiesForRole } from "../lib/authorization.ts";
import { resolveModuleAccess, type ModuleDefinition } from "../lib/modules.ts";

/* Módulos em construção (migration 0121): ERP DP, DP Operacional, Carteira e
   Agentes/Triagem. Ninguém além do administrador abre, a não ser que ele libere
   a pessoa nominalmente. Nem papel nem departamento vinculam ninguém a eles. */
const restritos = [
  ["erp_dp", "erpDp", "erp.access"],
  ["dp_operations", "dpOperations", "dp_operations.access"],
  ["portfolio", "portfolio", "portfolio.access"],
  ["agents", "agents", "agents.access"],
] as const;

const modulo = (key: string, route: string, capability: string): ModuleDefinition => ({
  key, name: key, description: "", category: "operacao", route, requiredCapability: capability,
  dependsOn: "", status: "active", position: 1,
});

const base = {
  planModules: new Set(restritos.map(([key]) => key)),
  workspaceGrants: new Map<string, boolean>(),
  workspaceStatus: "active",
  subscriptionStatus: "active",
  enabledKeys: new Set<string>(),
};

test("só o administrador tem as permissões dos módulos em construção", () => {
  for (const [, , capability] of restritos) {
    assert.ok(capabilitiesForRole("admin").includes(capability), `${capability} saiu do administrador`);
    for (const role of ["member", "observer", "guest"] as const) {
      assert.ok(!capabilitiesForRole(role).includes(capability), `${role} ganhou ${capability} pelo papel`);
    }
  }
});

test("membro sem liberação individual não abre, nem com o módulo no departamento", () => {
  for (const [key, route, capability] of restritos) {
    const acesso = resolveModuleAccess({
      ...base, module: modulo(key, route, capability), role: "member",
      departmentModules: new Set([key]),
    });
    assert.equal(acesso.allowed, false, `${key} abriu sem o administrador liberar`);
  }
});

test("com a liberação individual do administrador, abre; com o bloqueio, fecha até para admin", () => {
  for (const [key, route, capability] of restritos) {
    const liberado = resolveModuleAccess({
      ...base, module: modulo(key, route, capability), role: "member",
      memberGrants: new Map([[key, true]]),
    });
    assert.equal(liberado.allowed, true, `${key} não abriu com a liberação`);
    const bloqueado = resolveModuleAccess({
      ...base, module: modulo(key, route, capability), role: "admin",
      memberGrants: new Map([[key, false]]),
    });
    assert.equal(bloqueado.allowed, false);
  }
});

test("a migration cria os quatro módulos, cada um com a sua permissão, em todos os planos", async () => {
  const sql = await readFile(new URL("../drizzle/postgres/0121_restricted_modules.sql", import.meta.url), "utf8");
  for (const [key, route, capability] of restritos) {
    assert.match(sql, new RegExp(`'${key}', '[^']+', 'Em construção\\.[^']*', '[a-z]+', '${route}', '${capability}'`, "u"));
  }
  assert.match(sql, /INSERT INTO "fdp_plan_modules"/u);
});

test("toda rota dos módulos em construção exige a permissão do módulo", async () => {
  const { readdir } = await import("node:fs/promises");
  const pastas = { "erp-dp": "erp.access", dp: "dp_operations.access", portfolio: "portfolio.access", agents: "agents.access", triage: "agents.access" };
  for (const [pasta, capability] of Object.entries(pastas)) {
    const arquivos = (await readdir(new URL(`../app/api/${pasta}`, import.meta.url), { recursive: true }))
      .filter((nome) => String(nome).endsWith("route.ts"));
    assert.ok(arquivos.length > 0);
    for (const arquivo of arquivos) {
      const fonte = await readFile(new URL(`../app/api/${pasta}/${arquivo}`, import.meta.url), "utf8");
      const contextos = fonte.match(/await getWorkspaceContext\(/gu)?.length ?? 0;
      const guardas = fonte.match(new RegExp(`requireCapability\\(workspace, "${capability.replace(".", "\\.")}"\\)`, "gu"))?.length ?? 0;
      assert.equal(guardas, contextos, `app/api/${pasta}/${arquivo} abre o módulo sem checar ${capability}`);
    }
  }
});

test("as telas desses módulos dependem do próprio módulo, e não de Cadastros ou Integrações", async () => {
  const painel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(painel, /label: "DP Operacional", icon: CalendarCheck2, module: "dpOperations"/u);
  assert.match(painel, /label: "Carteira", icon: Briefcase, module: "portfolio"/u);
  assert.match(painel, /label: "Agentes", icon: Bot, module: "agents"/u);
  assert.match(painel, /label: "Triagem", icon: ShieldQuestion, module: "agents"/u);
  assert.match(painel, /enabledModules\.has\("erpDp"\)/u);
});
