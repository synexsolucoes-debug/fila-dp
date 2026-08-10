import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
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
    if (/Fila DP|FilaDP/u.test(source)) offenders.push(file.replace(root, ""));
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
  for (const token of ["--vin-navy-deep: #030A30", "--vin-navy: #102D5F", "--vin-blue: #0857B2",
    "--vin-blue-vivid: #0B86FE", "--vin-bg: #F6F8FC", "--vin-border: #DCE3ED"]) {
    assert.ok(globals.includes(token), `token ausente: ${token}`);
  }
  for (const semantic of ["--brand:", "--brand-strong:", "--brand-accent:", "--ui-surface:", "--ui-text:"]) {
    assert.ok(globals.includes(semantic), `token semântico ausente: ${semantic}`);
  }
});

test("a marca tem símbolo isolado e versão horizontal, e usa os tokens", async () => {
  const logo = await readFile(new URL("../app/components/VinculatoLogo.tsx", import.meta.url), "utf8");
  assert.match(logo, /export function VinculatoMark/);
  assert.match(logo, /export function VinculatoLogo/);
  assert.match(logo, /var\(--vin-navy-deep/);
  assert.match(logo, /var\(--vin-blue-vivid/);
  assert.match(logo, /VINCULATO_TAGLINE = "Sua operação, conectada\."/);
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
  assert.match(database, /WORKSPACE_SUSPENDED/);
  assert.match(login, /USER_BLOCKED/);
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
