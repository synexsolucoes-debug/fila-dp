import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const migrationDirectory = join(process.cwd(), "drizzle", "postgres");
const baselineExisting = process.argv.includes("--baseline-existing");
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;

if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL/Neon antes de executar as migrations.");
}

const sql = neon(databaseUrl, { fullResults: true });
const files = (await readdir(migrationDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
if (!files.length) throw new Error("Nenhuma migration PostgreSQL foi encontrada.");

await sql.query(`CREATE TABLE IF NOT EXISTS fdp_schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  execution_note text NOT NULL DEFAULT 'applied'
)`, []);

const existingApplication = Boolean((await sql.query("SELECT to_regclass('public.fdp_workspaces') AS table_name", [])).rows[0]?.table_name);
const appliedRows = await sql.query("SELECT id, checksum FROM fdp_schema_migrations ORDER BY id", []);
const applied = new Map(appliedRows.rows.map((row) => [String(row.id), String(row.checksum)]));

if (existingApplication && applied.size === 0 && !baselineExisting) {
  throw new Error("O banco já possui tabelas sem histórico de migration. Execute uma única vez: npm run db:migrate:baseline");
}

let createdCleanBaseline = false;
for (const file of files) {
  const source = await readFile(join(migrationDirectory, file), "utf8");
  const checksum = createHash("sha256").update(source).digest("hex");
  const previousChecksum = applied.get(file);
  if (previousChecksum) {
    if (previousChecksum !== checksum) throw new Error(`A migration já aplicada ${file} foi alterada.`);
    continue;
  }

  const isBaseline = file.startsWith("0000_");
  const isExistingCompatibility = file.includes("normalize_existing");
  if ((isBaseline && existingApplication && baselineExisting) || (isExistingCompatibility && createdCleanBaseline)) {
    const note = isBaseline ? "baselined-existing" : "skipped-clean-baseline";
    await sql.query("INSERT INTO fdp_schema_migrations (id, checksum, execution_note) VALUES ($1, $2, $3)", [file, checksum, note]);
    console.log(`${file}: ${note}`);
    continue;
  }

  const statements = source
    .split("--> statement-breakpoint")
    .flatMap((block) => block.split(/;\s*(?:\r?\n|$)/))
    .map((statement) => statement.trim())
    .filter(Boolean);
  await sql.transaction([
    sql.query("SELECT pg_advisory_xact_lock(81902141)", []),
    ...statements.map((statement) => sql.query(statement, [])),
    sql.query("INSERT INTO fdp_schema_migrations (id, checksum) VALUES ($1, $2)", [file, checksum]),
  ]);
  if (isBaseline) createdCleanBaseline = true;
  console.log(`${file}: applied`);
}

console.log("Migrations PostgreSQL concluídas.");
