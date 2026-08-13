const checks = {
  database: Boolean(String(process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL ?? "").startsWith("postgres")),
  vault: Boolean(String(process.env.FDP_SANKHYA_VAULT_KEYS ?? process.env.FDP_SANKHYA_VAULT_KEY ?? "").trim()),
  blob: Boolean(String(process.env.BLOB_READ_WRITE_TOKEN ?? "").trim()),
};

console.log(JSON.stringify(checks));
if (!process.argv.includes("--report-only") && (!checks.database || !checks.vault)) process.exitCode = 1;
