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
