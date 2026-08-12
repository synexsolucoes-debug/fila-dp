import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skip = new Set([".next", "node_modules", ".git", "dist"]);

async function walk(directory: string, extensions: string[]): Promise<string[]> {
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries) {
    if (skip.has(entry)) continue;
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) files.push(...await walk(path, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) files.push(path);
  }
  return files;
}

test("nenhum texto de interface ainda diz o nome antigo", async () => {
  const files = await walk(root, [".ts", ".tsx", ".css"]);
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // A marca também aparecia partida entre elementos ("Fila <strong>DP</strong>"),
    // que a busca por texto corrido não pegava. O padrão abaixo cobre os dois casos.
    if (/Fila DP|FilaDP|Fila\s*<(?:strong|b)>\s*DP/u.test(source)) offenders.push(file.replace(root, ""));
  }
  assert.deepEqual(offenders, [], `arquivos com o nome antigo: ${offenders.join(", ")}`);
});

test("identificadores técnicos foram preservados na renomeação", async () => {
  // Renomear tabela, variável de ambiente ou cabeçalho quebraria bancos e
  // integrações já instalados. O nome do produto mudou; o contrato técnico não.
  const [schema, api] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/competences/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /pgTable\("fdp_workspaces"/);
  assert.match(api, /x-fila-dp-request-id/);
});

test("a identidade visual vive em tokens, não espalhada em HEX", async () => {
  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  // Os dois azuis vêm dos pixels do símbolo oficial, não de estimativa.
  for (const token of ["--vin-navy: #062B60", "--vin-blue-vivid: #168CFD",
    "--vin-bg: #F6F8FC", "--vin-border: #DCE3ED"]) {
    assert.ok(globals.includes(token), `token ausente: ${token}`);
  }
  for (const semantic of ["--brand:", "--brand-strong:", "--brand-accent:", "--ui-surface:", "--ui-text:"]) {
    assert.ok(globals.includes(semantic), `token semântico ausente: ${semantic}`);
  }
});

test("a marca usa os arquivos oficiais, não um redesenho", async () => {
  const logo = await readFile(new URL("../app/components/VinculatoLogo.tsx", import.meta.url), "utf8");
  assert.match(logo, /export function VinculatoMark/);
  assert.match(logo, /export function VinculatoLogo/);
  // Arquivo oficial recortado, servido por next/image — sem path desenhado à mão.
  assert.match(logo, /markSource: "\/brand\/vinculato-mark\.png"/);
  assert.match(logo, /logoSource: "\/brand\/vinculato-logo\.png"/);
  assert.doesNotMatch(logo, /<path\s/u);
  assert.match(logo, /VINCULATO_TAGLINE = "Sua operação, conectada\."/);

  const [mark, wordmark, icon] = await Promise.all([
    stat(new URL("../public/brand/vinculato-mark.png", import.meta.url)),
    stat(new URL("../public/brand/vinculato-logo.png", import.meta.url)),
    stat(new URL("../app/icon.png", import.meta.url)),
  ]);
  assert.ok(mark.size > 1000, "o símbolo oficial precisa existir em public/brand");
  assert.ok(wordmark.size > 1000, "o logotipo oficial precisa existir em public/brand");
  assert.ok(icon.size > 200, "o favicon precisa ser gerado do símbolo oficial");
});

test("o verde-menta da marca anterior não voltou pelas bordas", async () => {
  // Restaram três acentos em telas escuras e um hover depois da troca de marca.
  // Verde de sucesso continua permitido: o que não pode é menta como identidade.
  const files = await walk(root, [".css"]);
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const legacy of ["#45dcb0", "#8ae0c5", "#0E3B3B", "#0e3b3b"]) {
      if (source.includes(legacy)) offenders.push(`${file.replace(root, "")} (${legacy})`);
    }
  }
  assert.deepEqual(offenders, [], `menta da marca antiga ainda no CSS: ${offenders.join(", ")}`);
});

test("o azul vivo nunca é a cor do texto sobre superfície clara", async () => {
  // --brand-accent puro fica em 3.39:1 sobre branco. Quem precisa de azul em
  // texto usa --ui-mint-text (claro) ou --brand-accent-on-dark (escuro).
  const dashboard = await readFile(new URL("../app/dashboard-modern.css", import.meta.url), "utf8");
  assert.ok(dashboard.includes("--ui-mint-text:"), "falta o par legível de --ui-mint");
  assert.ok(dashboard.includes("--ui-on-mint:"), "falta a cor de texto sobre preenchimento --ui-mint");
  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.ok(globals.includes("--brand-accent-on-dark:"), "falta o acento legível sobre navy");
});

test("a conferência WCAG faz parte do repositório, não de uma rodada avulsa", async () => {
  const script = await readFile(new URL("../scripts/a11y-check.mjs", import.meta.url), "utf8");
  // Gradiente medido de verdade: pular superfície com background-image foi o que
  // deixou passar três textos entre 3.09:1 e 4.09:1 na primeira rodada.
  assert.match(script, /gradientSurfaces/u);
  assert.match(script, /process\.exit\(failures === 0 \? 0 : 1\)/u);
  // As duas larguras: alvo de 24px muda com o layout.
  assert.match(script, /width: 390/u);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["a11y-check"], "node scripts/a11y-check.mjs");
});

test("nenhuma tela usa mais o marcador decorativo antigo", async () => {
  const files = await walk(root, [".tsx"]);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // O bloco de três barrinhas era um placeholder; a marca real substituiu.
    if (/brand-mark|brandMark/u.test(source)) offenders.push(file.replace(root, ""));
  }
  assert.deepEqual(offenders, [], `telas ainda com o marcador antigo: ${offenders.join(", ")}`);
});

test("o catálogo de planos publica os quatro planos de lançamento em centavos", async () => {
  const migration = await readFile(new URL("../drizzle/postgres/0022_plan_catalog_pricing.sql", import.meta.url), "utf8");
  for (const [code, cents, seats] of [
    ["starter", "0", "3"], ["standard", "9700", "10"], ["premium", "29700", "30"], ["enterprise", "79700", "100"],
  ] as const) {
    const block = migration.split(`WHERE "code" = '${code}'`)[0].split("UPDATE \"fdp_saas_plans\" SET").at(-1) ?? "";
    assert.ok(block.includes(`"monthly_price_cents" = ${cents}`), `${code} sem o preço ${cents}`);
    assert.ok(block.includes(`"included_seats" = ${seats}`), `${code} sem ${seats} assentos`);
    assert.ok(block.includes(`"status" = 'active'`), `${code} precisa estar ativo para ser vendido`);
  }
  // Preço é histórico versionado: alterar não pode mudar contrato antigo.
  assert.match(migration, /CREATE TABLE "fdp_saas_plan_prices"/);
  assert.match(migration, /plan prices are append-only/);
  assert.match(migration, /ALTER TABLE "fdp_workspace_subscriptions" ADD COLUMN IF NOT EXISTS "plan_price_id"/);
});

test("alterar preço no console global cria nova versão em vez de sobrescrever", async () => {
  const route = await readFile(new URL("../app/api/platform/plans/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /INSERT INTO fdp_saas_plan_prices/);
  assert.match(route, /const priceChanged =/);
  assert.match(route, /newPriceVersion: priceChanged/);
});

test("o limite de assentos explica plano, uso e limite", async () => {
  const route = await readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8");
  assert.match(route, /PLAN_SEAT_LIMIT/);
  assert.match(route, /permite \$\{allowance\.seat_limit\} usuário\(s\)/u);
  assert.match(route, /já estão em uso/u);
  assert.match(route, /SUBSCRIPTION_INACTIVE/);
  // A trava contra corrida continua no banco, não só na checagem prévia.
  assert.match(route, /pg_advisory_xact_lock/);
});

test("a administração da plataforma administra de verdade, e sempre com trilha", async () => {
  const [list, detail, users, userDetail] = await Promise.all([
    readFile(new URL("../app/api/platform/workspaces/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/workspaces/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/users/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/platform/users/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [list, detail, users, userDetail]) {
    assert.match(source, /requirePlatformAdmin/);
    assert.match(source, /withPlatformContext/);
  }
  // Criar workspace é transacional e nasce com proprietário, papel e assinatura.
  assert.match(list, /provisionWorkspaceDefaults\(tenant, workspaceId, statements\)/);
  assert.match(list, /INSERT INTO fdp_workspace_members \(workspace_id, user_id, role\) VALUES \(\?, \?, 'admin'\)/);
  assert.match(list, /INSERT INTO fdp_workspace_subscriptions/);
  // Senha nunca é inventada: o proprietário novo entra pela recuperação de acesso.
  assert.match(list, /Nunca criamos senha padrão nem senha em texto aberto/u);
  // Toda alteração administrativa grava na trilha global.
  for (const source of [list, detail, userDetail]) {
    assert.match(source, /INSERT INTO fdp_platform_audit_events/);
  }
  // Salvaguardas exigidas antes de liberar o produto.
  assert.match(detail, /PLAN_DOWNGRADE_BLOCKED/);
  assert.match(detail, /STATUS_REASON_REQUIRED/);
  assert.match(userDetail, /OWNER_BLOCK_BLOCKED/);
  assert.match(userDetail, /OWNER_UNLINK_BLOCKED/);
  // Bloquear derruba as sessões abertas: sem isso o bloqueio só valeria no próximo login.
  assert.match(userDetail, /DELETE FROM fdp_auth_sessions WHERE user_id = \?/);
  // A listagem global não projeta material de senha.
  assert.doesNotMatch(users, /password_hash AS|password_salt/);
});

test("usuário bloqueado e workspace suspenso perdem acesso de verdade", async () => {
  const [database, login, migration] = await Promise.all([
    readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0023_platform_lifecycle.sql", import.meta.url), "utf8"),
  ]);
  // Vale em toda requisição, não só no login.
  assert.match(database, /USER_BLOCKED/);
  assert.match(login, /USER_BLOCKED/);
  // Workspace fora do ar continua sem operar — mas a recusa deixou de derrubar
  // a sessão inteira. Quem tem outro grupo ativo entra nele; quem não tem
  // recebe NO_ACTIVE_WORKSPACE dizendo qual grupo está em qual estado.
  const access = await readFile(new URL("../lib/workspace-access.ts", import.meta.url), "utf8");
  assert.match(access, /OPERATIONAL_WORKSPACE_STATUSES = new Set\(\["active"\]\)/u);
  assert.match(database, /noAccessibleWorkspaceError/u);
  assert.match(access, /"NO_ACTIVE_WORKSPACE"/u);
  // O banco exige motivo registrado para qualquer estado que corte acesso.
  assert.match(migration, /"fdp_workspaces_status_reason_check"/);
  assert.match(migration, /"fdp_users_status_reason_check"/);
  assert.match(migration, /"status" IN \('active', 'suspended', 'canceled', 'archived'\)/);
});

test("provisionar pela plataforma usa os dois contextos na mesma transação", async () => {
  const adapter = await readFile(new URL("../db/index.ts", import.meta.url), "utf8");
  assert.match(adapter, /export function getPlatformScopedD1/);
  assert.match(adapter, /set_config\('app\.workspace_id', \$\{this\.boundContext\.workspaceId\}, true\)[\s\S]{0,120}set_config\('app\.platform_admin', 'true', true\)/);
  // Não existe caminho que dispense o workspace: a marca de plataforma sozinha
  // continua sem acesso às tabelas do cliente.
  assert.match(adapter, /if \(this\.boundContext && this\.withPlatformFlag\)/);
});

test("excluir um grupo é irreversível, então exige quatro portas antes", async () => {
  const source = await readFile(new URL("../app/api/platform/workspaces/[id]/delete/route.ts", import.meta.url), "utf8");
  assert.match(source, /requirePlatformAdmin\(/u);
  // Não se exclui um grupo em operação por engano.
  assert.match(source, /WORKSPACE_NOT_ARCHIVED/u);
  // O identificador digitado por extenso impede que o clique caia no grupo errado.
  assert.match(source, /confirmation !== workspace\.slug/u);
  assert.match(source, /WORKSPACE_DELETE_REASON_REQUIRED/u);
});

test("a contagem da exclusão roda dentro do escopo do tenant", async () => {
  const source = await readFile(new URL("../app/api/platform/workspaces/[id]/delete/route.ts", import.meta.url), "utf8");
  // Contando pela conexão de plataforma a RLS esconde as linhas do cliente e o
  // COUNT devolve zero sem erro: o registro anotou 4 linhas onde havia 6 no
  // primeiro ensaio. Número inventado é pior que número nenhum num registro que
  // existe para ser prova.
  assert.match(source, /const scoped = getPlatformScopedD1\(/u);
  assert.match(source, /scoped\.prepare\(`SELECT COUNT\(\*\) AS total FROM \$\{table\}/u);
  const countAt = source.indexOf("const counts: Record<string, number> = {}");
  const deleteAt = source.indexOf("DELETE FROM fdp_workspaces");
  assert.ok(countAt > 0 && deleteAt > countAt, "a contagem precisa acontecer antes da remoção");
});

test("a trilha do grupo é removida explicitamente, e o registro de exclusão é imutável", async () => {
  const source = await readFile(new URL("../app/api/platform/workspaces/[id]/delete/route.ts", import.meta.url), "utf8");
  // Uma exclusão de auditoria precisa estar escrita no código de quem a fez,
  // não escondida numa constraint CASCADE.
  assert.match(source, /DELETE FROM fdp_audit_events WHERE workspace_id = \?/u);
  assert.match(source, /set_config\('app\.audit_maintenance', 'on', true\)/u);

  const migration = await readFile(new URL("../drizzle/postgres/0034_workspace_deletion_ledger.sql", import.meta.url), "utf8");
  // Sem FK para o grupo: ele deixa de existir, e o registro precisa sobreviver.
  assert.doesNotMatch(migration, /REFERENCES "public"\."fdp_workspaces"[\s\S]{0,80}fdp_workspace_deletions/u);
  assert.match(migration, /workspace deletion records are immutable/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "fdp_workspace_deletions"/u);
});

test("excluir o último grupo não tranca a instalação", async () => {
  const route = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  const bootstrap = route.slice(route.indexOf("const credentials = await hashPassword"), route.indexOf("const claimedWorkspace"));
  // Depois de excluir o último grupo, a conta do dono sobrevive sem workspace:
  // a primeira instalação fica aberta e o e-mail continua cadastrado. Recusar
  // ali trancaria o sistema sem saída pela interface — a senha correta é o que
  // autoriza reivindicar o primeiro grupo.
  assert.match(bootstrap, /verifyPassword\(password, current\.password_salt/u);
  assert.match(bootstrap, /Este e-mail já possui uma conta/u);
});
