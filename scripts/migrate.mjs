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
  const canonicalSource = source.replace(/\r\n/g, "\n").trimEnd();
  const checksum = createHash("sha256").update(canonicalSource).digest("hex");
  const crlfSource = canonicalSource.replace(/\n/g, "\r\n");
  const compatibleChecksums = new Set([
    checksum,
    createHash("sha256").update(source).digest("hex"),
    createHash("sha256").update(`${canonicalSource}\n`).digest("hex"),
    createHash("sha256").update(crlfSource).digest("hex"),
    createHash("sha256").update(`${crlfSource}\r\n`).digest("hex"),
  ]);
  const previousChecksum = applied.get(file);
  if (previousChecksum) {
    if (!compatibleChecksums.has(previousChecksum)) throw new Error(`A migration já aplicada ${file} foi alterada.`);
    continue;
  }

  if (file === "0002_chief_venom.sql" && existingApplication) {
    const existingCreatedBy = (await sql.query(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'fdp_access_recovery_tokens'
         AND column_name = 'created_by'`,
      [],
    )).rows[0];
    if (existingCreatedBy) {
      if (existingCreatedBy.data_type !== "text" || existingCreatedBy.is_nullable !== "NO") {
        throw new Error("A coluna legado fdp_access_recovery_tokens.created_by nao possui a definicao segura esperada.");
      }
      await sql.transaction([
        sql.query("SELECT pg_advisory_xact_lock(81902141)", []),
        sql.query("ALTER TABLE fdp_access_recovery_tokens ALTER COLUMN created_by SET DEFAULT 'system'", []),
        sql.query("INSERT INTO fdp_schema_migrations (id, checksum, execution_note) VALUES ($1, $2, $3)", [file, checksum, "normalized-existing-column"]),
      ]);
      console.log(`${file}: normalized-existing-column`);
      continue;
    }
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
