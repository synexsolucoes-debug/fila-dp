/**
 * Ensaio de backup e restauração (§86).
 *
 * Um backup só vale quando a restauração é provada. Este script faz o ciclo
 * completo contra PostgreSQL real:
 *
 *   1. aplica as migrations em um banco de origem;
 *   2. semeia dados representativos de dois clientes;
 *   3. gera o dump;
 *   4. restaura em um banco vazio;
 *   5. compara contagem por tabela entre origem e destino;
 *   6. confere que políticas de RLS, triggers e constraints sobreviveram;
 *   7. confirma que o isolamento multi-tenant continua valendo no restaurado;
 *   8. mede a duração de cada etapa para alimentar RPO/RTO.
 *
 * Uso:
 *   FDP_DR_ADMIN_DATABASE_URL="postgres://user@host:5432/postgres" \
 *   FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true npm run db:rehearse-restore
 *
 * O usuário informado precisa poder criar e remover bancos. Aponte sempre para
 * uma instância descartável: o script cria e destrói bancos de ensaio.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adminUrl = process.env.FDP_DR_ADMIN_DATABASE_URL;
if (!adminUrl?.startsWith("postgres")) {
  throw new Error("Defina FDP_DR_ADMIN_DATABASE_URL apontando para um PostgreSQL de teste com permissão de criar bancos.");
}
if (process.env.FDP_ALLOW_EPHEMERAL_SCHEMA_TEST !== "true") {
  throw new Error("Defina FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true para autorizar a criação e remoção dos bancos de ensaio.");
}

const stamp = Date.now().toString(36);
const sourceDb = `fdp_dr_source_${stamp}`;
const targetDb = `fdp_dr_target_${stamp}`;
for (const name of [sourceDb, targetDb]) {
  if (!/^fdp_dr_(source|target)_[0-9a-z]+$/u.test(name)) throw new Error("Nome de banco de ensaio inválido.");
}

const root = process.cwd();
const workingDirectory = await mkdtemp(join(tmpdir(), "fdp-dr-"));
const dumpFile = join(workingDirectory, "backup.dump");

function databaseUrl(name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function run(command, args, { input, allowFailure = false, env } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", input, env: env ? { ...process.env, ...env } : process.env });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} falhou (status ${result.status}).`);
  }
  return result;
}

function psql(url, { file, sql, tuplesOnly = false } = {}) {
  const args = [url, "-v", "ON_ERROR_STOP=1"];
  if (tuplesOnly) args.push("-tA");
  if (file) args.push("-f", file);
  if (sql) args.push("-c", sql);
  const result = run("psql", args);
  return (result.stdout ?? "").trim();
}

const timings = [];
async function step(label, action) {
  const startedAt = Date.now();
  const value = await action();
  const durationMs = Date.now() - startedAt;
  timings.push({ label, durationMs });
  console.log(`• ${label}: ${(durationMs / 1000).toFixed(2)}s`);
  return value;
}

/* -------------------------------------------------------------------------- */

const failures = [];
let cleanupNeeded = false;
try {
await step("preparar bancos de ensaio", () => {
  cleanupNeeded = true;
  psql(adminUrl, { sql: `DROP DATABASE IF EXISTS ${sourceDb}` });
  psql(adminUrl, { sql: `DROP DATABASE IF EXISTS ${targetDb}` });
  psql(adminUrl, { sql: `CREATE DATABASE ${sourceDb}` });
  psql(adminUrl, { sql: `CREATE DATABASE ${targetDb}` });
});

await step("aplicar migrations na origem", () => {
  // Pelo executor de produção, e não por uma concatenação própria.
  //
  // Antes este passo montava um único script com todos os arquivos dentro de um
  // BEGIN/COMMIT, e precisava reordenar à mão os índices únicos das migrations
  // 0014–0017 para o script fechar. O efeito colateral era o ensaio provar que
  // *aquele* schema restaura — um schema que nunca existe em produção, montado
  // por um caminho que ninguém usa, e sem histórico em `fdp_schema_migrations`.
  //
  // Usando `scripts/migrate.mjs` o ensaio passa a restaurar exatamente o que o
  // cliente tem, incluindo o histórico de migrations, e a divergência entre os
  // dois caminhos deixa de existir por construção.
  run("node", [join(root, "scripts", "migrate.mjs")], {
    env: { DATABASE_URL: databaseUrl(sourceDb), FDP_DB_DRIVER: "pg" },
  });
});

await step("semear dados de dois clientes", () => {
  psql(databaseUrl(sourceDb), { file: join(root, "scripts", "dr-seed.sql") });
});

/** Assinatura da base: contagem por tabela, para comparar origem e destino. */
const countsQuery = `SELECT string_agg(entry, E'\\n' ORDER BY entry) FROM (
  SELECT format('%s=%s', table_name, (xpath('/row/c/text()',
    query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text) AS entry
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fdp_%'
) AS counted`;

const sourceCounts = await step("medir a origem", () => psql(databaseUrl(sourceDb), { sql: countsQuery, tuplesOnly: true }));

await step("gerar o dump", () => {
  run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpFile, databaseUrl(sourceDb)]);
});

await step("restaurar em banco vazio", () => {
  run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", databaseUrl(targetDb), dumpFile]);
});

const targetCounts = await step("medir o restaurado", () => psql(databaseUrl(targetDb), { sql: countsQuery, tuplesOnly: true }));

/* -------------------------------------------------------------------------- */
/* Verificações                                                                */
/* -------------------------------------------------------------------------- */

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
}

console.log("\nVerificações da restauração:");

check("contagem por tabela idêntica", sourceCounts === targetCounts,
  sourceCounts === targetCounts ? "" : "a origem e o destino divergem");
if (sourceCounts !== targetCounts) {
  const sourceMap = new Map(sourceCounts.split("\n").map((line) => line.split("=")));
  for (const line of targetCounts.split("\n")) {
    const [table, count] = line.split("=");
    if (sourceMap.get(table) !== count) console.log(`      ${table}: origem=${sourceMap.get(table) ?? "ausente"} destino=${count}`);
  }
}

const seeded = Number(psql(databaseUrl(targetDb), { sql: "SELECT count(*) FROM fdp_workspaces", tuplesOnly: true }));
check("dados de negócio presentes no restaurado", seeded >= 2, `workspaces=${seeded}`);

const policyCount = Number(psql(databaseUrl(targetDb), { sql: "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'", tuplesOnly: true }));
const sourcePolicies = Number(psql(databaseUrl(sourceDb), { sql: "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'", tuplesOnly: true }));
check("políticas de RLS preservadas", policyCount === sourcePolicies && policyCount > 0, `origem=${sourcePolicies} destino=${policyCount}`);

const forcedRls = Number(psql(databaseUrl(targetDb), {
  sql: "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relforcerowsecurity",
  tuplesOnly: true,
}));
const sourceForced = Number(psql(databaseUrl(sourceDb), {
  sql: "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relforcerowsecurity",
  tuplesOnly: true,
}));
check("FORCE ROW LEVEL SECURITY preservado", forcedRls === sourceForced && forcedRls > 0, `origem=${sourceForced} destino=${forcedRls}`);

const triggerCount = Number(psql(databaseUrl(targetDb), {
  sql: "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal",
  tuplesOnly: true,
}));
const sourceTriggers = Number(psql(databaseUrl(sourceDb), {
  sql: "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal",
  tuplesOnly: true,
}));
check("triggers de imutabilidade preservados", triggerCount === sourceTriggers && triggerCount > 0, `origem=${sourceTriggers} destino=${triggerCount}`);

const constraintCount = Number(psql(databaseUrl(targetDb), {
  sql: "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'",
  tuplesOnly: true,
}));
const sourceConstraints = Number(psql(databaseUrl(sourceDb), {
  sql: "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'",
  tuplesOnly: true,
}));
check("constraints preservadas", constraintCount === sourceConstraints && constraintCount > 0, `origem=${sourceConstraints} destino=${constraintCount}`);

// O teste que importa de verdade: o backup restaurado ainda isola clientes.
const isolation = run("psql", [databaseUrl(targetDb), "-v", "ON_ERROR_STOP=1", "-tA", "-f", join(root, "scripts", "dr-verify-isolation.sql")]);
const isolationOutput = `${isolation.stdout ?? ""}${isolation.stderr ?? ""}`;
check("isolamento multi-tenant continua válido no restaurado", isolationOutput.includes("ISOLAMENTO_OK"), isolationOutput.trim().split("\n").pop() ?? "");

// Um fechamento concluído continua imutável depois do restore.
const immutability = run("psql", [databaseUrl(targetDb), "-tA", "-c",
  "UPDATE fdp_contractor_closings SET net_amount = 1 WHERE id = 'dr-ccl-1'"], { allowFailure: true });
check("fechamento concluído segue imutável no restaurado",
  (immutability.stderr ?? "").includes("closed payment closing is immutable"),
  (immutability.stderr ?? "").trim().split("\n")[0] ?? "");

await step("remover bancos de ensaio", () => {
  psql(adminUrl, { sql: `DROP DATABASE IF EXISTS ${sourceDb}` });
  psql(adminUrl, { sql: `DROP DATABASE IF EXISTS ${targetDb}` });
});
cleanupNeeded = false;
} finally {
  if (cleanupNeeded) {
    psql(adminUrl, { sql: `DROP DATABASE IF EXISTS ${sourceDb} WITH (FORCE)` });
    psql(adminUrl, { sql: `DROP DATABASE IF EXISTS ${targetDb} WITH (FORCE)` });
    console.log("Bancos temporarios removidos apos a interrupcao do ensaio.");
  }
}

/* -------------------------------------------------------------------------- */

const dumpDuration = timings.find((item) => item.label === "gerar o dump")?.durationMs ?? 0;
const restoreDuration = timings.find((item) => item.label === "restaurar em banco vazio")?.durationMs ?? 0;

console.log("\nTempos medidos neste ensaio:");
for (const entry of timings) console.log(`  ${entry.label}: ${(entry.durationMs / 1000).toFixed(2)}s`);
console.log(`\nDump: ${(dumpDuration / 1000).toFixed(2)}s · Restauração: ${(restoreDuration / 1000).toFixed(2)}s`);
console.log("Os tempos acima referem-se ao volume semeado no ensaio e não são promessa de RTO em produção.");

if (failures.length) {
  console.error(`\nEnsaio de restauração REPROVADO em ${failures.length} verificação(ões):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nEnsaio de backup e restauração APROVADO: dump, restore, contagens, RLS, triggers, constraints, isolamento e imutabilidade verificados.");
