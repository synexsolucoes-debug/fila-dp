import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { enabledModuleKeys, moduleAccessMessages, resolveModules, type ModuleDefinition } from "../lib/modules.ts";

const definition = (over: Partial<ModuleDefinition> = {}): ModuleDefinition => ({
  key: "processes", name: "Operação DP", description: "", category: "folha", route: "processes",
  requiredCapability: "competences.read", dependsOn: "", status: "active", position: 100, ...over,
});

const base = {
  modules: [definition()],
  planModules: new Set(["processes"]),
  workspaceGrants: new Map<string, boolean>(),
  role: "admin",
  workspaceStatus: "active",
  subscriptionStatus: "active",
};

test("módulo contratado e com capability é liberado", () => {
  const [resolved] = resolveModules(base);
  assert.equal(resolved.allowed, true);
  assert.equal(resolved.reason, "ok");
  assert.deepEqual(enabledModuleKeys([resolved]), ["processes"]);
});

test("módulo fora do plano é recusado como upgrade, não como falta de permissão", () => {
  const [resolved] = resolveModules({ ...base, planModules: new Set() });
  assert.equal(resolved.allowed, false);
  assert.equal(resolved.reason, "not_in_plan");
  assert.equal(resolved.upgradeable, true);
  assert.match(resolved.message, /plano contratado/u);
});

test("o administrador do workspace não consegue liberar módulo fora do plano", () => {
  // Mesmo com todas as capabilities, a etapa comercial acontece antes.
  const [resolved] = resolveModules({ ...base, planModules: new Set(), role: "admin" });
  assert.equal(resolved.allowed, false);
  assert.equal(resolved.reason, "not_in_plan");
});

test("liberação especial da plataforma vale sem mudar o plano", () => {
  const [resolved] = resolveModules({
    ...base, planModules: new Set(), workspaceGrants: new Map([["processes", true]]),
  });
  assert.equal(resolved.allowed, true);
});

test("revogação da plataforma vence a inclusão do plano", () => {
  const [resolved] = resolveModules({ ...base, workspaceGrants: new Map([["processes", false]]) });
  assert.equal(resolved.allowed, false);
  assert.equal(resolved.reason, "revoked_by_platform");
  assert.equal(resolved.upgradeable, false);
});

test("workspace suspenso e assinatura inativa bloqueiam antes de qualquer permissão", () => {
  assert.equal(resolveModules({ ...base, workspaceStatus: "suspended" })[0].reason, "workspace_inactive");
  assert.equal(resolveModules({ ...base, subscriptionStatus: "past_due" })[0].reason, "subscription_inactive");
  // Teste é aceito como assinatura válida.
  assert.equal(resolveModules({ ...base, subscriptionStatus: "trialing" })[0].allowed, true);
});

test("módulo inativo no catálogo global some para todo mundo", () => {
  const [resolved] = resolveModules({ ...base, modules: [definition({ status: "inactive" })] });
  assert.equal(resolved.allowed, false);
  assert.equal(resolved.reason, "module_inactive");
});

test("capability ausente recusa com motivo próprio, diferente de plano", () => {
  const [resolved] = resolveModules({ ...base, role: "guest" });
  assert.equal(resolved.allowed, false);
  assert.equal(resolved.reason, "missing_capability");
  assert.match(resolved.message, /administrador do grupo/u);
});

test("dependência não liberada impede o dependente", () => {
  const resolved = resolveModules({
    ...base,
    modules: [definition({ key: "processes", position: 100 }), definition({ key: "time_tracking", route: "timeTracking", requiredCapability: "time.read", dependsOn: "processes", position: 200 })],
    planModules: new Set(["time_tracking"]),
  });
  const dependent = resolved.find((item) => item.key === "time_tracking")!;
  assert.equal(dependent.allowed, false);
  assert.equal(dependent.reason, "dependency_missing");
});

test("todo motivo de recusa tem mensagem própria — nenhuma genérica", () => {
  for (const [reason, message] of Object.entries(moduleAccessMessages)) {
    if (reason === "ok") { assert.equal(message, ""); continue; }
    assert.ok(message.length > 20, `${reason} precisa de mensagem própria`);
    assert.doesNotMatch(message, /Não foi possível concluir a operação/u);
  }
});

test("o catálogo semeado aponta só para telas que existem no painel", async () => {
  const [migration, workspaceApp] = await Promise.all([
    readFile(new URL("../drizzle/postgres/0024_module_catalog.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);
  // Só o bloco VALUES do catálogo: a lista do CHECK de categoria tem o mesmo formato.
  const valuesBlock = migration.split('INSERT INTO "fdp_modules"')[1]?.split("ON CONFLICT")[0] ?? "";
  const routes = [...valuesBlock.matchAll(/\('[a-z_]+', '[^']+', '[^']*', '[a-z]+', '([A-Za-z]+)'/gu)].map((match) => match[1]);
  assert.ok(routes.length >= 12, `catálogo com poucos módulos: ${routes.length}`);
  /* `access` e `saas` continuam existindo como módulos de capacidade, e só
   deles: as pastas de interface no painel foram removidas — a de acessos por
   duplicar a gestão de membros que já vive lá, e a de assinatura porque
   administrar plano é da plataforma por desenho. */
const platformOnly = new Set(["access", "saas"]);
  for (const route of routes.filter((route) => !platformOnly.has(route))) {
    assert.ok(workspaceApp.includes(`"${route}"`), `rota ${route} não existe no painel`);
  }
  assert.doesNotMatch(workspaceApp, /view === "(?:access|saas)"/u, "administração global não volta ao painel por compatibilidade do catálogo");
});

test("os planos incluem módulos em escada crescente", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0024_module_catalog.sql", import.meta.url), "utf8");
  // Starter é o mais enxuto e Enterprise recebe o catálogo inteiro.
  assert.match(migration, /p\."code" = 'starter'[\s\S]{0,200}m\."key" IN \('board', 'inbox', 'planner', 'registrations', 'saas'\)/u);
  assert.match(migration, /WHERE p\."code" = 'enterprise'\r?\nON CONFLICT DO NOTHING/u);
  // Liberação especial exige motivo registrado.
  assert.match(migration, /"fdp_workspace_module_grants_reason_check" CHECK \(length\("reason"\) >= 5\)/u);
  // O cliente lê as próprias liberações; só a plataforma escreve.
  assert.match(migration, /CREATE POLICY "fdp_workspace_module_grants_write"[\s\S]{0,160}app\.platform_admin/u);
});

test("o menu do painel respeita o plano, e o servidor continua sendo a proteção real", async () => {
  const [workspaceApp, database] = await Promise.all([
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workspaceApp, /const hasModule = useCallback/);
  // O filtro deixou de estar escrito treze vezes no JSX e passou a ser uma
  // regra só sobre o catálogo. O que este teste garante continua sendo o
  // mesmo: cada tela paga declara a rota que a libera.
  assert.match(workspaceApp, /if \(entry\.module && !hasModule\(entry\.module\)\) return false;/u);
  for (const route of ["timeTracking", "contractorPayments", "integrations", "registrations", "payroll", "processes"]) {
    assert.ok(workspaceApp.includes(`module: "${route}"`), `menu não filtra ${route}`);
  }
  assert.match(database, /export async function getWorkspaceModules/);
  assert.match(database, /modules: resolvedModules/);
  // A proteção de rota segue por capability no servidor, não pelo menu.
  assert.match(workspaceApp, /prote..o real continua no servidor/iu);
});
