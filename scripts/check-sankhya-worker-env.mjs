const checks = {
  database: Boolean(String(process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL ?? "").startsWith("postgres")),
  vault: Boolean(String(process.env.FDP_INTEGRATION_VAULT_KEYS ?? process.env.FDP_INTEGRATION_VAULT_KEY ?? "").trim()),
  piiHash: Boolean(String(process.env.FDP_PII_HASH_SECRET ?? process.env.FDP_AUTH_SECRET ?? "").trim()),
  blob: Boolean(String(process.env.BLOB_READ_WRITE_TOKEN ?? "").trim()),
};

console.log(JSON.stringify(checks));
if (!process.argv.includes("--report-only") && (!checks.database || !checks.vault || !checks.piiHash)) process.exitCode = 1;
