/**
 * Ensaio do banco contra um PostgreSQL real.
 *
 * Aplica todas as migrations em um banco descartável e verifica, com SQL de
 * verdade, o que os testes de unidade não conseguem provar: constraints do
 * cálculo PJ, imutabilidade dos fechamentos concluídos, ajustes append-only,
 * outbox imutável, lease das entregas de webhook, unicidade das chaves de API,
 * janela do limite por minuto, idempotência e isolamento multi-tenant sob RLS
 * usando um papel sem superusuário.
 *
 * Uso:
 *   FDP_PAYMENTS_TEST_DATABASE_URL="postgres://user@host:5432/scratch" \
 *   FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true npm run db:rehearse-payments
 *
 * O banco informado é usado apenas para leitura/escrita das tabelas do Fila DP
 * e nunca deve apontar para produção.
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitPostgresStatements } from "./sql-statements.mjs";

const databaseUrl = process.env.FDP_PAYMENTS_TEST_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina FDP_PAYMENTS_TEST_DATABASE_URL apontando para um PostgreSQL de teste dedicado.");
}
if (process.env.FDP_ALLOW_EPHEMERAL_SCHEMA_TEST !== "true") {
  throw new Error("Defina FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true para autorizar a escrita no banco de teste.");
}

const root = process.cwd();
const migrationsDirectory = join(root, "drizzle", "postgres");
const files = (await readdir(migrationsDirectory)).filter((file) => /^\d{4}_.+\.sql$/u.test(file)).sort();

// Reproduz as regras do executor: a compatibilidade de banco legado é ignorada
// quando o baseline limpo acabou de ser criado.
let cleanBaseline = false;
let script = "";
for (const file of files) {
  if (file.includes("normalize_existing") && cleanBaseline) continue;
  const source = await readFile(join(migrationsDirectory, file), "utf8");
  const statements = splitPostgresStatements(source);
  let ordered = statements;
  if (/^001[4-7]_/u.test(file)) {
    const uniqueIndexes = statements.filter((statement) => /\bCREATE UNIQUE INDEX\b/u.test(statement));
    const remaining = statements.filter((statement) => !/\bCREATE UNIQUE INDEX\b/u.test(statement));
    const firstForeignKey = remaining.findIndex((statement) => /\bALTER TABLE\b[\s\S]+\bADD CONSTRAINT\b/u.test(statement));
    if (firstForeignKey >= 0 && uniqueIndexes.length > 0) {
      ordered = [...remaining.slice(0, firstForeignKey), ...uniqueIndexes, ...remaining.slice(firstForeignKey)];
    }
  }
  script += `\\echo === ${file} ===\n${ordered.map((statement) => `${statement};`).join("\n")}\n`;
  if (file.startsWith("0000_")) cleanBaseline = true;
}

const workingDirectory = await mkdtemp(join(tmpdir(), "fdp-payments-rehearsal-"));
const migrationsFile = join(workingDirectory, "migrations.sql");
await writeFile(migrationsFile, `BEGIN;\n${script}COMMIT;\n`);

function psql(file) {
  const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout ?? "");
  const stderr = result.stderr ?? "";
  const relevant = stderr.split("\n").filter((line) => !/will be truncated|already exists, skipping|does not exist, skipping/u.test(line)).join("\n");
  if (relevant.trim()) process.stderr.write(`${relevant}\n`);
  if (result.status !== 0) throw new Error(`psql falhou ao executar ${file}.`);
}

// O ensaio semeia identificadores fixos: precisa de um banco vazio para que uma
// segunda execução não falhe por chave duplicada e confunda o diagnóstico.
const guardFile = join(workingDirectory, "guard.sql");
await writeFile(guardFile, `DO $$
BEGIN
  IF to_regclass('public.fdp_workspaces') IS NOT NULL THEN
    RAISE EXCEPTION 'O banco informado ja contem tabelas do Fila DP. Use um banco vazio e descartavel para o ensaio.';
  END IF;
END;
$$;
`);
psql(guardFile);
psql(migrationsFile);
psql(join(root, "scripts", "payments-db-rehearsal.sql"));
psql(join(root, "scripts", "scale-db-rehearsal.sql"));
psql(join(root, "scripts", "time-db-rehearsal.sql"));
console.log("Ensaio concluído: migrations, constraints de pagamento, regra do §22 no ponto, outbox/webhooks/API e isolamento multi-tenant verificados.");
