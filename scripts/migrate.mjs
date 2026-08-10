import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { splitPostgresStatements } from "./sql-statements.mjs";

/**
 * O executor de migrations aceita os dois drivers: Neon por HTTP em produção e
 * PostgreSQL direto em desenvolvimento. Sem isso não é possível aplicar o
 * schema em um banco local para reproduzir erros antes de corrigi-los.
 */
async function createMigrationSql(url) {
  const explicit = String(process.env.FDP_DB_DRIVER ?? "").trim().toLowerCase();
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const local = explicit === "pg" || (explicit !== "neon" && !process.env.VERCEL && ["localhost", "127.0.0.1", "::1"].includes(host));
  if (!local) return neon(url, { fullResults: true });

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 4 });
  const normalize = (result) => ({ rows: result.rows ?? [], rowCount: result.rowCount ?? 0 });
  // Consulta preguiçosa, igual à do Neon: descreve e só executa quando aguardada
  // ou quando entra em transaction(). Executar na criação dispararia os comandos
  // da migration fora da transação e fora de ordem.
  const lazy = (text, values) => ({
    text,
    values,
    then: (resolve, reject) => pool.query(text, values).then((result) => resolve(normalize(result)), reject),
  });
  const sql = (strings, ...values) => lazy(
    strings.reduce((acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ""), ""),
    values,
  );
  sql.query = (text, values = []) => lazy(text, values);
  sql.transaction = async (queries) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const query of queries) results.push(normalize(await client.query(query.text, query.values)));
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  return sql;
}

const migrationDirectory = join(process.cwd(), "drizzle", "postgres");
const baselineExisting = process.argv.includes("--baseline-existing");
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;

if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL/Neon antes de executar as migrations.");
}

// Desenvolvimento local usa o driver PostgreSQL direto; produção continua no Neon.
const sql = await createMigrationSql(databaseUrl);
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

  let compatibilityStatements = [];

  if (file === "0004_auth_rate_limits.sql" && existingApplication) {
    const existingRateLimitTable = Boolean((await sql.query("SELECT to_regclass('public.fdp_auth_rate_limits') AS table_name", [])).rows[0]?.table_name);
    if (existingRateLimitTable) {
      const columnRows = (await sql.query(`SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fdp_auth_rate_limits'`, [])).rows;
      const columns = new Map(columnRows.map((row) => [String(row.column_name), row]));
      const expectedColumns = new Map([
        ["key_hash", ["text", "NO"]],
        ["window_started_at", ["timestamp with time zone", "NO"]],
        ["blocked_until", ["timestamp with time zone", "YES"]],
        ["updated_at", ["timestamp with time zone", "NO"]],
      ]);
      const legacyAttemptColumn = !columns.has("failure_count") && columns.get("attempt_count")?.data_type === "integer" && columns.get("attempt_count")?.is_nullable === "NO";
      const failureColumn = columns.get("failure_count") ?? columns.get("attempt_count");
      const compatible = failureColumn?.data_type === "integer" && failureColumn?.is_nullable === "NO" && [...expectedColumns].every(([name, [dataType, nullable]]) => {
        const column = columns.get(name);
        return column?.data_type === dataType && column?.is_nullable === nullable;
      });
      if (!compatible) throw new Error("A tabela legado fdp_auth_rate_limits nao possui a definicao segura esperada.");
      await sql.transaction([
        sql.query("SELECT pg_advisory_xact_lock(81902141)", []),
        ...(legacyAttemptColumn ? [sql.query('ALTER TABLE "fdp_auth_rate_limits" RENAME COLUMN "attempt_count" TO "failure_count"', [])] : []),
        sql.query('CREATE INDEX IF NOT EXISTS "fdp_auth_rate_limits_blocked_idx" ON "fdp_auth_rate_limits" USING btree ("blocked_until")', []),
        sql.query("INSERT INTO fdp_schema_migrations (id, checksum, execution_note) VALUES ($1, $2, $3)", [file, checksum, "normalized-existing-table"]),
      ]);
      console.log(`${file}: normalized-existing-table`);
      continue;
    }
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

  if (file === "0014_operation_dp_foundation.sql" && existingApplication) {
    const legacyVersionColumns = (await sql.query(`SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fdp_process_versions'`, [])).rows;
    const columns = new Map(legacyVersionColumns.map((row) => [String(row.column_name), row]));
    const legacyShape = columns.size === 6
      && columns.get("id")?.data_type === "text"
      && columns.get("board_id")?.data_type === "text"
      && columns.get("version")?.data_type === "integer"
      && columns.get("snapshot_json")?.data_type === "text"
      && columns.get("created_by")?.data_type === "text"
      && columns.get("created_at")?.data_type === "timestamp with time zone";
    if (legacyShape) {
      const legacyDestination = Boolean((await sql.query("SELECT to_regclass('public.fdp_legacy_board_process_versions') AS table_name", [])).rows[0]?.table_name);
      if (legacyDestination) throw new Error("A tabela de destino legado fdp_legacy_board_process_versions ja existe.");
      compatibilityStatements = [
        sql.query('ALTER TABLE "fdp_process_versions" RENAME TO "fdp_legacy_board_process_versions"', []),
        sql.query('ALTER TABLE "fdp_legacy_board_process_versions" RENAME CONSTRAINT "fdp_process_versions_pkey" TO "fdp_legacy_board_process_versions_pkey"', []),
        sql.query('ALTER TABLE "fdp_legacy_board_process_versions" RENAME CONSTRAINT "fdp_process_versions_board_id_fdp_boards_id_fk" TO "fdp_legacy_board_process_versions_board_fk"', []),
        sql.query('ALTER INDEX "fdp_process_versions_board_created_idx" RENAME TO "fdp_legacy_board_process_versions_created_idx"', []),
        sql.query('ALTER INDEX "fdp_process_versions_board_version_uq" RENAME TO "fdp_legacy_board_process_versions_version_uq"', []),
      ];
    } else if (columns.size > 0) {
      throw new Error("A tabela existente fdp_process_versions nao possui a definicao legado esperada.");
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

  const statements = splitPostgresStatements(source);
  let orderedStatements = statements;
  if (/^001[4-7]_/u.test(file)) {
    const uniqueIndexes = statements.filter((statement) => /\bCREATE UNIQUE INDEX\b/u.test(statement));
    const remaining = statements.filter((statement) => !/\bCREATE UNIQUE INDEX\b/u.test(statement));
    const firstForeignKey = remaining.findIndex((statement) => /\bALTER TABLE\b[\s\S]+\bADD CONSTRAINT\b/u.test(statement));
    if (firstForeignKey >= 0 && uniqueIndexes.length > 0) {
      orderedStatements = [
        ...remaining.slice(0, firstForeignKey),
        ...uniqueIndexes,
        ...remaining.slice(firstForeignKey),
      ];
    }
  }
  await sql.transaction([
    sql.query("SELECT pg_advisory_xact_lock(81902141)", []),
    ...compatibilityStatements,
    ...orderedStatements.map((statement) => sql.query(statement, [])),
    sql.query("INSERT INTO fdp_schema_migrations (id, checksum) VALUES ($1, $2)", [file, checksum]),
  ]);
  if (isBaseline) createdCleanBaseline = true;
  console.log(`${file}: applied`);
}

console.log("Migrations PostgreSQL concluídas.");
