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
