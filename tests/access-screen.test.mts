import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilities, capabilitiesForRole, workspaceRoles } from "../lib/authorization.ts";
import { capabilitiesOfArea, capabilityAreas, capabilityCatalog, roleSummaries } from "../lib/capability-catalog.ts";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("toda capacidade do sistema é explicada em linguagem de cliente", () => {
  // Sem isso o administrador escolhe o papel no escuro: "competences.transition"
  // não significa nada para quem opera o DP.
  for (const capability of capabilities) {
    const described = capabilityCatalog[capability];
    assert.ok(described, `capacidade sem descrição no catálogo: ${capability}`);
    assert.ok(described.label.length > 8, `descrição curta demais para ${capability}`);
    assert.doesNotMatch(described.label, /\./u, `${capability}: rótulo é frase curta, não parágrafo`);
    assert.ok(capabilityAreas.some((area) => area.key === described.area), `${capability} aponta para área inexistente`);
  }
  // Nada descrito a mais: catálogo e autorização não podem divergir.
  for (const key of Object.keys(capabilityCatalog)) {
    assert.ok((capabilities as readonly string[]).includes(key), `descrição órfã: ${key}`);
  }
  // Cada área existe de fato na matriz.
  for (const area of capabilityAreas) {
    assert.ok(capabilitiesOfArea(area.key).length > 0, `área vazia: ${area.key}`);
  }
});

test("a matriz mostrada é a autorização real do sistema", () => {
  const granted = Object.fromEntries(workspaceRoles.map((role) => [role, new Set(capabilitiesForRole(role))]));
  assert.equal(granted.admin.size, capabilities.length, "administrador precisa ter todas as capacidades");

  // Administrador e membro formam a escada esperada.
  for (const [wider, narrower] of [["admin", "member"], ["member", "observer"], ["admin", "guest"]] as const) {
    for (const capability of granted[narrower]) {
      assert.ok(granted[wider].has(capability), `${narrower} tem ${capability} que ${wider} não tem`);
    }
    assert.ok(granted[wider].size > granted[narrower].size, `${wider} deveria conceder mais que ${narrower}`);
  }

  // Convidado NÃO é um observador reduzido: ele enxerga menos, mas pode
  // comentar — é o papel de quem participa de um assunto pontual. Observador é
  // consulta pura. Confundir os dois na tela levaria o administrador a liberar
  // escrita achando que está liberando leitura.
  assert.ok(granted.guest.has("comments.write"), "convidado precisa poder comentar");
  assert.ok(!granted.observer.has("comments.write"), "observador é somente consulta");
  assert.ok(granted.observer.size > granted.guest.size, "observador enxerga mais que convidado");
  assert.match(roleSummaries.guest, /coment/iu, "o resumo do convidado precisa avisar que ele escreve comentários");
  assert.match(roleSummaries.observer, /consult/iu, "o resumo do observador precisa deixar claro que é só leitura");

  for (const role of workspaceRoles) {
    assert.ok(roleSummaries[role].length > 40, `resumo do papel ${role} precisa explicar o alcance`);
  }
});

test("a tela de usuários existe como visão própria do painel", async () => {
  const panel = await source("../app/painel/WorkspaceApp.tsx");
  assert.match(panel, /import \{ AccessView \} from "\.\/features\/access"/u);
  assert.match(panel, /view === "access" && <AccessView/u);
  assert.match(panel, /hasModule\("access"\)/u, "a visão precisa respeitar a liberação por plano");
  assert.match(panel, /access: \{ eyebrow: "ACESSO DO GRUPO"/u);
});

test("a tela cobre o que uma revisão de acesso exige", async () => {
  const view = await source("../app/painel/features/access/AccessView.tsx");
  // Assentos do plano, para o administrador saber se ainda pode convidar.
  assert.match(view, /seatsFull/u);
  assert.match(view, /limite atingido/u);
  // Quem nunca entrou e quem está com ativação pendente.
  assert.match(view, /Nunca acessou/u);
  assert.match(view, /Ativação pendente/u);
  // Escopo por empresa e papel, as duas dimensões do acesso.
  assert.match(view, /updateMemberAccess\(member\.userId, \{ role:/u);
  assert.match(view, /updateMemberAccess\(selected\.userId, \{ companyIds: companyDraft \}\)/u);
  // Remoção pede confirmação: perder acesso não pode ser um clique distraído.
  assert.match(view, /window\.confirm\(/u);
  // A matriz de permissões vem da autorização, não de texto paralelo.
  assert.match(view, /capabilitiesForRole/u);
});

test("a tela de usuários nunca cria, exibe ou envia senha", async () => {
  const view = await source("../app/painel/features/access/AccessView.tsx");
  const api = await source("../app/painel/features/access/access.api.ts");
  const route = await source("../app/api/members/access/route.ts");
  for (const [name, code] of [["tela", view], ["api", api]] as const) {
    assert.doesNotMatch(code, /password|senha_provisoria|generatePassword/iu, `${name} não pode tocar em senha`);
  }
  // A rota consulta o hash apenas para saber se a conta já foi ativada — e
  // nunca o seleciona nem o devolve. Testar a menção do nome da coluna seria
  // proibir a checagem legítima; o que precisa ser proibido é o valor sair.
  assert.match(route, /\(u\.password_hash IS NOT NULL\) AS is_activated/u);
  assert.doesNotMatch(route, /SELECT[^;]*\bu\.password_hash\b(?![^;]*IS NOT NULL)/u);
  assert.doesNotMatch(route, /password_hash:|passwordHash/u, "o hash nunca entra na resposta");
  // O caminho é sempre o link único de ativação, definido pela própria pessoa.
  assert.match(view, /LINK ÚNICO DE ATIVAÇÃO/u);
  assert.match(view, /a senha é definida pela própria pessoa e nunca fica visível aqui/u);
  assert.match(route, /is_activated/u);
});

test("a rota de acesso exige permissão e devolve o limite real do plano", async () => {
  const route = await source("../app/api/members/access/route.ts");
  assert.match(route, /requireCapability\(workspace\.role, "members\.directory\.read"\)/u);
  assert.match(route, /GREATEST\(s\.seat_quantity, p\.included_seats\)/u);
  // Sem assinatura o produto não inventa limite.
  assert.match(route, /subscriptionStatus: "none"/u);
  assert.match(route, /max\(s\.last_seen_at\)/u);
});

test("o módulo de usuários é liberado em todos os planos", async () => {
  const migration = await source("../drizzle/postgres/0025_access_module.sql");
  assert.match(migration, /'access', 'Usuários e permissões'/u);
  assert.match(migration, /'members\.directory\.read'/u);
  // Administrar o próprio grupo não é recurso pago: entra em todo plano.
  assert.match(migration, /SELECT p\."id", 'access' FROM "fdp_saas_plans" p\s*\nON CONFLICT DO NOTHING;/u);
  assert.doesNotMatch(migration, /WHERE p\."code"/u, "nenhum plano pode ficar sem a administração de usuários");
});
