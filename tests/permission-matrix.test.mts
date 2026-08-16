import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilities, hasCapability } from "../lib/authorization.ts";
import { capabilityOwners, deniedWriteCapabilities, moduleWriteCapabilities } from "../lib/modules.ts";

/**
 * §11: a matriz de permissões.
 *
 * O modelo existia e era bom — 70 capacidades, quatro papéis, capacidades
 * restritas ao dono, exceções individuais por pessoa. O que não existia era
 * *uma* matriz: havia duas.
 *
 * Cento e quatro rotas perguntavam `requireCapability(workspace, "…")`, que
 * respeita as exceções individuais. Outras vinte e seis perguntavam
 * `requireWorkspaceRole(role, ["admin", "member"])` — uma lista de papéis crua,
 * que ignora as exceções. A tela de acessos deixava um administrador negar um
 * módulo a uma pessoa, e para essas vinte e seis rotas a negação não existia.
 *
 * Verificado contra o produto de pé, antes da correção: um membro com Demandas,
 * Inbox e Planner **todos negados** enviou `POST /api/cards` e recebeu 201 —
 * criou uma demanda no quadro que não podia sequer ler. Depois da correção, a
 * mesma requisição recebe 403 `CAPABILITY_REQUIRED`, e o administrador sem
 * exceções continua recebendo 201.
 */

const routes = await (async () => {
  const { readdir } = await import("node:fs/promises");
  const raiz = new URL("../app/api/", import.meta.url);
  const encontrados: Array<[string, string]> = [];
  async function andar(dir: URL, prefixo: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await andar(new URL(`${entry.name}/`, dir), `${prefixo}${entry.name}/`);
      else if (entry.name === "route.ts") encontrados.push([`${prefixo}route.ts`, await readFile(new URL(entry.name, dir), "utf8")]);
    }
  }
  await andar(raiz, "");
  return encontrados;
})();

test("papel e capacidade andam juntos: nenhuma rota confia só na lista de papéis", () => {
  // A lista de papéis não enxerga a exceção individual. Onde ela for o único
  // guarda, a negação feita na tela de acessos não vale.
  const EXCECOES = new Set([
    // Grava a conexão de agenda da própria pessoa (`user_id`), não um recurso
    // do grupo, e nenhum módulo do catálogo a governa. Inventar uma capacidade
    // só para ela criaria uma linha na matriz que não corresponde a nada que se
    // possa liberar ou negar na tela.
    "calendar/connections/route.ts",
  ]);
  const sozinhas: string[] = [];
  for (const [caminho, fonte] of routes) {
    if (!fonte.includes("requireWorkspaceRole")) continue;
    if (EXCECOES.has(caminho)) continue;
    if (!/requireCapability|requireNamedCapability/u.test(fonte)) sozinhas.push(caminho);
  }
  assert.deepEqual(sozinhas, [],
    "rota guardada só por papel: a exceção individual não chega até ela");
});

test("toda rota de escrita passa por alguma autorização", () => {
  const semGuarda: string[] = [];
  const PUBLICAS = new Set([
    "auth/login/route.ts", "auth/logout/route.ts", "auth/reset/route.ts", "auth/signup/route.ts",
    "auth/sessions/route.ts", "auth/sessions/[id]/route.ts",
    "site/contact/route.ts", "client-errors/route.ts",
    "saas/webhook/stripe/route.ts", "integrations/webhook/[channel]/route.ts",
    "integrations/worker/route.ts", "webhooks/worker/route.ts",
    "boards/select/route.ts", "workspaces/select/route.ts",
    "notifications/[id]/read/route.ts", "notifications/read-all/route.ts",
    "assistant/chat/route.ts", "v1/contractor-components/route.ts",
  ]);
  for (const [caminho, fonte] of routes) {
    if (!/export async function (POST|PATCH|PUT|DELETE)/u.test(fonte)) continue;
    if (PUBLICAS.has(caminho)) continue;
    const guarda = /requireCapability|requireNamedCapability|requireWorkspaceRole|requirePlatformAdmin|hasCapability/u.test(fonte);
    if (!guarda) semGuarda.push(caminho);
  }
  assert.deepEqual(semGuarda, [], "rota de escrita sem nenhuma verificação de autorização");
});

test("negar um módulo nega a escrita dele, não só a leitura", () => {
  // O defeito, em uma linha: `fdp_modules` guarda uma capacidade por módulo — a
  // de leitura, que decide se o módulo aparece. Negar retirava só essa.
  const negados = new Map([["board", false], ["inbox", false], ["planner", false]]);
  const resultado = deniedWriteCapabilities(negados);
  assert.ok(resultado.has("cards.write"), "quem não vê o quadro não pode escrever nele");
  assert.ok(resultado.has("comments.write"));
  assert.ok(resultado.has("attachments.write"));
});

test("negar um módulo não cala a escrita que outro módulo liberado governa", () => {
  // `cards.write` pertence a Demandas, Inbox e Planner ao mesmo tempo. Negar só
  // o Inbox não pode impedir quem continua com o quadro liberado de trabalhar.
  assert.equal(deniedWriteCapabilities(new Map([["inbox", false]])).has("cards.write"), false);
  assert.equal(deniedWriteCapabilities(new Map([["board", false]])).has("cards.write"), false);
  // E módulo sem exceção nenhuma não nega nada: ele segue o papel e o plano.
  assert.equal(deniedWriteCapabilities(new Map()).size, 0);
  // Liberar um módulo tampouco nega.
  assert.equal(deniedWriteCapabilities(new Map([["board", true]])).size, 0);
});

test("liberar continua sendo só leitura — a exceção não promove ninguém", async () => {
  // A tela diz isso por escrito, e a assimetria é deliberada: liberar mostra o
  // módulo, escrever continua vindo do papel.
  const db = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  const fn = db.slice(db.indexOf("export async function loadMemberModuleGrants"));
  const corpo = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(corpo, /if \(granted\) extraCapabilities\.add\(capability\);/u);
  assert.doesNotMatch(corpo, /grantedWriteCapabilities|extraCapabilities\.add\(write/u);

  const tela = await readFile(new URL("../app/painel/features/shared/MemberModules.tsx", import.meta.url), "utf8");
  assert.match(tela, /as ações de escrita continuam vindo do papel/u);
});

test("cada capacidade de escrita tem ao menos um módulo dono", () => {
  // Uma capacidade de escrita sem dono é uma linha da matriz que a tela de
  // acessos não consegue mexer: o administrador vê o módulo, nega, e aquela
  // ação continua liberada sem explicação.
  const somenteLeitura = /\.(read|directory\.read|status\.read)$/u;
  const orfas = capabilities.filter((capability) =>
    !somenteLeitura.test(capability)
    && !capabilityOwners.has(capability)
    // Ciclo de vida do grupo e trilha global não são módulo: quem os exerce é
    // o dono ou a plataforma, e a tela de acessos não os oferece.
    && !/^workspace\.|^audit\.|^integrations\.view$/u.test(capability));
  assert.deepEqual(orfas, []);
});

test("o mapa de módulos cobre os módulos do catálogo", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0033_member_module_grants.sql", import.meta.url), "utf8");
  assert.match(migration, /fdp_member_module_grants/u);
  for (const key of ["board", "inbox", "planner", "processes", "time_tracking", "auxiliary",
    "psychologist_payments", "contractor_payments", "registrations", "integrations",
    "sankhya_browser", "payroll", "indicators", "access", "saas"]) {
    assert.ok(key in moduleWriteCapabilities, `módulo ${key} fora do mapa de escrita`);
  }
});

test("os papéis base não mudaram com a correção", () => {
  // A restrição de papel ficou onde estava: onde ela era mais estreita que a
  // capacidade, trocá-la por capacidade teria *alargado* o acesso. Cinco rotas
  // eram assim — exclusão permanente de demanda, conversão de inbox, métricas
  // de RH, catálogo e listas.
  assert.equal(hasCapability("member", "cards.write"), true);
  assert.equal(hasCapability("observer", "cards.write"), false);
  assert.equal(hasCapability("guest", "cards.write"), false);
  assert.equal(hasCapability("guest", "comments.write"), true);
  assert.equal(hasCapability("observer", "attachments.read"), true);
  assert.equal(hasCapability("member", "workspace.manage"), false);
  assert.equal(hasCapability("member", "members.manage"), false);
  assert.equal(hasCapability("admin", "workspace.delete"), false, "excluir o grupo é do dono");
});

test("a negação individual vence o papel, e não o contrário", () => {
  const sujeito = { role: "member", deniedCapabilities: new Set(["cards.write"]) };
  assert.equal(hasCapability(sujeito, "cards.write"), false);
  // E a concessão individual soma ao papel sem apagar o resto.
  const observador = { role: "observer", extraCapabilities: new Set(["time.read"]) };
  assert.equal(hasCapability(observador, "time.read"), true);
  assert.equal(hasCapability(observador, "cards.write"), false);
});
