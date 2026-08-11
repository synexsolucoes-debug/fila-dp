import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { capabilities, capabilitiesForRole, workspaceRoles } from "../lib/authorization.ts";
import { capabilitiesOfArea, capabilityAreas, capabilityCatalog, roleSummaries } from "../lib/capability-catalog.ts";

async function walk(directory: string, extensions: string[]): Promise<string[]> {
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) files.push(...await walk(path, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) files.push(path);
  }
  return files;
}

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
  assert.match(route, /requireCapability\(workspace, "members\.directory\.read"\)/u);
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

test("o console da plataforma abre workspace e usuário, não só arquiva", async () => {
  const console_ = await source("../app/plataforma/PlatformConsole.tsx");
  const detail = await source("../app/plataforma/PlatformDetail.tsx");
  // O console listava e oferecia quase só arquivar: administrar exigia adivinhar
  // quem estava dentro do cliente e o que já tinha acontecido.
  assert.match(console_, /WorkspaceDetailDrawer/u);
  assert.match(console_, /UserDetailDrawer/u);
  assert.match(console_, /setOpenWorkspace\(workspace\.id\)/u);
  assert.match(console_, /setOpenUser\(user\.id\)/u);

  // Workspace: ficha, abas e ações de plano e ciclo de vida.
  for (const marker of ["Plano e limites", "Ciclo de vida", "Membros", "Empresas", "Módulos", "Auditoria"]) {
    assert.ok(detail.includes(marker), `detalhe do workspace sem "${marker}"`);
  }
  // Usuário: identidade e associações são coisas distintas.
  for (const marker of ["Associações de workspace", "Sessões ativas", "Histórico administrativo"]) {
    assert.ok(detail.includes(marker), `detalhe do usuário sem "${marker}"`);
  }
  // Papel muda só na associação alterada.
  assert.match(detail, /workspaceId: membership\.workspaceId, membership: "link", role: event\.target\.value/u);
  // O e-mail não é editável por aqui: é chave de login e de convite.
  assert.doesNotMatch(detail, /patch\(\{ email:/u);
});

test("as rotas de detalhe exigem administrador de plataforma e não vazam credencial", async () => {
  const workspace = await source("../app/api/platform/workspaces/[id]/detail/route.ts");
  const user = await source("../app/api/platform/users/[id]/detail/route.ts");
  for (const [name, route] of [["workspace", workspace], ["usuário", user]] as const) {
    assert.match(route, /requirePlatformAdmin\(auth\.user\)/u, `rota de ${name} sem autorização de plataforma`);
    assert.match(route, /withPlatformContext/u);
    assert.doesNotMatch(route, /token_hash|password_hash:|passwordHash/u, `rota de ${name} não pode devolver credencial`);
  }
  // A sessão aparece para poder ser revogada, mas sem o token que a identifica.
  assert.match(user, /SELECT id, device_label, created_at, last_seen_at, expires_at/u);
  // Administrar contrato não é motivo para ler a operação do cliente.
  assert.doesNotMatch(workspace, /FROM fdp_cards|FROM fdp_competences/u);
});

/* -------------------------------------------------------------------------- */
/* Permissão individual, além do papel                                        */
/* -------------------------------------------------------------------------- */

test("bloqueio individual vence o papel, e liberação individual não vira promoção", async () => {
  const { hasCapability } = await import("../lib/authorization.ts");

  // O papel sozinho continua valendo onde não há exceção.
  assert.equal(hasCapability("admin", "members.manage"), true);
  assert.equal(hasCapability("observer", "members.manage"), false);

  // Negar é a exceção restritiva: uma restrição contornável não é restrição.
  assert.equal(hasCapability({ role: "admin", deniedCapabilities: new Set(["members.manage"]) }, "members.manage"), false);
  // Liberar concede só o que foi concedido — não abre o resto do papel superior.
  const liberado = { role: "member", extraCapabilities: new Set(["hr.read"]) };
  assert.equal(hasCapability(liberado, "hr.read"), true);
  assert.equal(hasCapability(liberado, "members.manage"), false, "liberar um módulo não pode promover a administrador");
  // Negar vence liberar quando os dois aparecem: o restritivo tem precedência.
  assert.equal(hasCapability({
    role: "member",
    extraCapabilities: new Set(["hr.read"]),
    deniedCapabilities: new Set(["hr.read"]),
  }, "hr.read"), false);
});

test("o módulo bloqueado individualmente diz que foi o administrador do grupo", async () => {
  const { resolveModules, moduleAccessMessages } = await import("../lib/modules.ts");
  const modules = [{
    key: "payroll", name: "Folha", description: "", category: "folha" as const, route: "/painel",
    requiredCapability: "hr.read", dependsOn: "", status: "active" as const, position: 100,
  }];
  const base = {
    modules,
    planModules: new Set(["payroll"]),
    workspaceGrants: new Map<string, boolean>(),
    workspaceStatus: "active",
    subscriptionStatus: "active",
  };

  const semExcecao = resolveModules({ ...base, role: "admin" });
  assert.equal(semExcecao[0].allowed, true);

  const bloqueado = resolveModules({ ...base, role: "admin", memberGrants: new Map([["payroll", false]]) });
  assert.equal(bloqueado[0].allowed, false);
  assert.equal(bloqueado[0].reason, "denied_for_member");
  // O motivo aponta quem decidiu: "não está no plano" mandaria a pessoa cobrar
  // a empresa errada.
  assert.match(moduleAccessMessages.denied_for_member, /administrador do grupo/u);

  // Liberar supre a capacidade de leitura que o papel não tem.
  const semPapel = resolveModules({ ...base, role: "guest" });
  assert.equal(semPapel[0].allowed, false);
  assert.equal(semPapel[0].reason, "missing_capability");
  const liberado = resolveModules({ ...base, role: "guest", memberGrants: new Map([["payroll", true]]) });
  assert.equal(liberado[0].allowed, true);
});

test("liberação individual não passa por cima do plano", async () => {
  const { resolveModules } = await import("../lib/modules.ts");
  const modules = [{
    key: "payroll", name: "Folha", description: "", category: "folha" as const, route: "/painel",
    requiredCapability: "hr.read", dependsOn: "", status: "active" as const, position: 100,
  }];
  // Liberar para uma pessoa o que o grupo não contratou seria vender por dentro
  // da tela. O plano continua acima da exceção.
  const foraDoPlano = resolveModules({
    modules,
    planModules: new Set<string>(),
    workspaceGrants: new Map<string, boolean>(),
    memberGrants: new Map([["payroll", true]]),
    role: "admin",
    workspaceStatus: "active",
    subscriptionStatus: "active",
  });
  assert.equal(foraDoPlano[0].allowed, false);
  assert.equal(foraDoPlano[0].reason, "not_in_plan");
});

test("a permissão individual vale em todos os pontos de checagem, não em alguns", async () => {
  const files = await walk(new URL("../app/api", import.meta.url).pathname, [".ts"]);
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // Passar apenas o papel ignoraria a exceção individual naquele ponto —
    // permissão que vale em alguns lugares e não em outros é pior que nenhuma.
    if (/(?:require|has)Capability\(workspace\.role,/u.test(source)) offenders.push(file.split("/app/")[1]);
  }
  assert.deepEqual(offenders, [], `rotas ainda autorizando só pelo papel: ${offenders.join(", ")}`);
});

test("a rota de acesso individual respeita plano, capacidade e trava de auto-bloqueio", async () => {
  const source = await readFile(new URL("../app/api/members/[id]/modules/route.ts", import.meta.url), "utf8");
  assert.match(source, /requireCapability\(workspace, "members\.directory\.read"\)/u);
  assert.match(source, /requireCapability\(workspace, "members\.manage"\)/u);
  assert.match(source, /MODULE_NOT_CONTRACTED/u);
  // Sem esta trava o grupo pode ficar sem ninguém capaz de devolver a permissão.
  assert.match(source, /SELF_LOCKOUT/u);
  // Exceção de acesso sem trilha vira mistério na próxima revisão.
  assert.match(source, /member_module\.(granted|denied|cleared)/u);
});
