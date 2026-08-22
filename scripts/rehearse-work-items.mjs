/**
 * Ensaio da Central de Trabalho contra PostgreSQL real.
 *
 * Por que um ensaio separado: as consultas das fontes de trabalho não são
 * literais de `.prepare(` — elas são montadas por `buildWorkItemQuery`, com o
 * escopo de empresa e o recorte pessoal entrando como condição. O verificador
 * de SQL inline não as alcança, e uma coluna renomeada quebraria a Central em
 * produção sem nenhum sinal antes.
 *
 * O ensaio prepara cada fonte nas duas variantes de escopo, com e sem recorte
 * por empresa. Nada é executado nem escrito: só `PREPARE`, dentro de uma
 * transação que sofre ROLLBACK no fim.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node --experimental-strip-types scripts/rehearse-work-items.mjs
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL com as migrations aplicadas.");
}

const { workItemSources, buildWorkItemQuery } = await import("../lib/work-items.ts");
const { toPostgresParameters } = await import("../lib/postgres-parameters.ts");
const { Client } = await import("pg");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
await client.query("BEGIN");

const failures = [];
let prepared = 0;

const variants = [
  { scope: "mine", companyIds: ["empresa-1", "empresa-2"], label: "meu trabalho, escopo por empresa" },
  { scope: "mine", companyIds: null, label: "meu trabalho, sem restrição de empresa" },
  { scope: "team", companyIds: [], label: "equipe, sem nenhuma empresa liberada" },
  { scope: "team", companyIds: null, label: "equipe, sem restrição de empresa" },
];

for (const variant of variants) {
  for (const source of workItemSources) {
    const { sql } = buildWorkItemQuery({
      source,
      workspaceId: "workspace-ensaio",
      userId: "usuario-ensaio",
      scope: variant.scope,
      companyIds: variant.companyIds,
      limit: 50,
    });
    const name = `work_item_${prepared}`;
    try {
      await client.query(`PREPARE ${name} AS ${toPostgresParameters(sql)}`);
      prepared += 1;
    } catch (error) {
      failures.push(`${source.key} (${variant.label}): ${String(error.message).split("\n")[0]}`);
    }
  }
}

await client.query("ROLLBACK");
await client.end();

for (const failure of failures) console.error(`FALHA  ${failure}`);
console.log(`Central de Trabalho: ${prepared} consultas preparadas, ${failures.length} falhas.`);
if (failures.length) process.exitCode = 1;
