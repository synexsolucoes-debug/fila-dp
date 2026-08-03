import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { toPostgresParameters } from "../lib/postgres-parameters.ts";
import { getEnabledFeatureFlags } from "../lib/feature-flags.ts";

test("converte apenas placeholders fora de textos SQL", () => {
  assert.equal(
    toPostgresParameters("SELECT '?' AS literal, id FROM x WHERE a = ? AND b = ?"),
    "SELECT '?' AS literal, id FROM x WHERE a = $1 AND b = $2",
  );
});

test("flags sensíveis permanecem desligadas em produção sem autorização adicional", () => {
  const flags = getEnabledFeatureFlags({
    NODE_ENV: "production",
    FDP_FEATURE_FLAGS: "aiBoardOrchestration,erpWriteback,automaticSensitiveChanges",
    FDP_ALLOW_SENSITIVE_FEATURES: "false",
  });
  assert.deepEqual([...flags], ["aiBoardOrchestration"]);
});

test("rotas não inicializam schema nem traduzem dialeto SQLite", async () => {
  const database = await readFile(new URL("../db/index.ts", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.doesNotMatch(database, /PRAGMA|INSERT\s+OR\s+IGNORE|datetime\s*\(/i);
  assert.doesNotMatch(workspace, /CREATE\s+TABLE|ensureSchema|PRAGMA/i);
});

test("token de recuperação mantém a autoria exigida pela API", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/postgres/0002_chief_venom.sql", import.meta.url), "utf8");
  assert.match(schema, /createdBy:\s*text\("created_by"\)\.notNull\(\)/);
  assert.match(migration, /ADD COLUMN "created_by" text DEFAULT 'system' NOT NULL/);
});

test("legacy timestamp defaults are bridged around the type conversion", async () => {
  const prepare = await readFile(new URL("../drizzle/postgres/0001_0_prepare_legacy_defaults.sql", import.meta.url), "utf8");
  const normalize = await readFile(new URL("../drizzle/postgres/0001_normalize_existing_neon.sql", import.meta.url), "utf8");
  const restore = await readFile(new URL("../drizzle/postgres/0001_z_restore_timestamp_defaults.sql", import.meta.url), "utf8");
  assert.match(prepare, /ALTER COLUMN "created_at" DROP DEFAULT/);
  assert.match(normalize, /ALTER COLUMN "created_at" TYPE timestamptz/);
  assert.match(restore, /ALTER COLUMN "created_at" SET DEFAULT now\(\)/);
  assert.ok("0001_0_prepare_legacy_defaults.sql" < "0001_normalize_existing_neon.sql");
  assert.ok("0001_normalize_existing_neon.sql" < "0001_z_restore_timestamp_defaults.sql");
});

test("the legacy recovery author column is normalized instead of recreated", async () => {
  const migrator = await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(migrator, /file === "0002_chief_venom\.sql"/);
  assert.match(migrator, /ALTER COLUMN created_by SET DEFAULT 'system'/);
  assert.match(migrator, /normalized-existing-column/);
});

test("migration checksums ignore only line endings and final whitespace", async () => {
  const migrator = await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(migrator, /replace\(\/\\r\\n\/g, "\\n"\)\.trimEnd\(\)/);
  assert.match(migrator, /compatibleChecksums/);
});
