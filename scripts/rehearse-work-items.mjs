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

const {
  workItemSources, buildWorkItemQuery, buildWorkCenterQuery, buildWorkCountsQuery,
  buildWorkGroupQuery, emptyWorkItemFilters, workItemGroups, workItemSorts,
} = await import("../lib/work-items.ts");
const { namedQueries, buildNamedQuery } = await import("../lib/assistant/named-queries.ts");
const { toPostgresParameters } = await import("../lib/postgres-parameters.ts");
const { Client } = await import("pg");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
await client.query("BEGIN");

const failures = [];
let prepared = 0;
let savepoint = 0;

/**
 * Um SAVEPOINT por preparação.
 *
 * Sem ele, a primeira consulta inválida aborta a transação e todas as seguintes
 * reportam `25P02` — o relatório passaria a acusar cem defeitos inexistentes e
 * esconderia o único verdadeiro. É o mesmo cuidado do verificador de SQL inline.
 */
async function tryPrepare(sql, label) {
  const mark = `rehearse_${savepoint += 1}`;
  await client.query(`SAVEPOINT ${mark}`);
  try {
    await client.query(`PREPARE ${mark} AS ${toPostgresParameters(sql)}`);
    await client.query(`RELEASE SAVEPOINT ${mark}`);
    return true;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${mark}`);
    failures.push(`${label}: ${String(error.message).split("\n")[0]}`);
    return false;
  }
}

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
    });
    if (await tryPrepare(sql, `${source.key} (${variant.label})`)) prepared += 1;
  }
}

/* As consultas nomeadas da IA (§61) entram no mesmo ensaio e pelo mesmo motivo:
   elas também são montadas em vez de escritas como literal, e uma coluna
   renomeada faria o assistente responder "não sei" sem que ninguém soubesse
   por quê. */
let namedPrepared = 0;
for (const companyIds of [["empresa-1", "empresa-2"], null, []]) {
  for (const query of namedQueries) {
    const { sql } = buildNamedQuery({
      query, workspaceId: "workspace-ensaio", userId: "usuario-ensaio", companyIds,
    });
    if (await tryPrepare(sql, `consulta nomeada ${query.key}`)) namedPrepared += 1;
  }
}

/* A consulta que a Central realmente executa é a **união** das fontes, com
   filtro, ordenação, cursor e contadores. Preparar as fontes uma a uma não
   prova que a união casa: basta uma coluna fora de ordem em uma delas para o
   `UNION ALL` inteiro deixar de compilar — e o sintoma em produção seria "a
   Central não abre", sem dizer qual fonte. */
let unionPrepared = 0;
const cursorSamples = {
  urgency: ["0", "2026-01-05T12:00:00.000Z", "2026-01-01T00:00:00.000Z", "card-1"],
  due: ["2026-01-05T12:00:00.000Z", "0", "2026-01-01T00:00:00.000Z", "card-1"],
  priority: ["1", "2026-01-05T12:00:00.000Z", "2026-01-01T00:00:00.000Z", "card-1"],
  created: ["2026-01-01T00:00:00.000Z", "card-1"],
  updated: ["2026-01-09T00:00:00.000Z", "card-1"],
};

for (const variant of variants) {
  for (const sort of workItemSorts) {
    for (const cursor of [[], cursorSamples[sort.key]]) {
      const built = buildWorkCenterQuery({
        sources: workItemSources,
        workspaceId: "workspace-ensaio",
        userId: "usuario-ensaio",
        companyIds: variant.companyIds,
        filters: {
          ...emptyWorkItemFilters, scope: variant.scope, due: "week",
          companyId: "empresa-1", processId: "processo-1",
          priority: "urgent", status: "open", origin: "teams",
        },
        sort: sort.key,
        cursor,
        limit: 25,
      });
      if (!built) continue;
      if (await tryPrepare(built.sql, `união ${variant.label} / ${sort.key} / cursor ${cursor.length}`)) unionPrepared += 1;
    }
  }

  const counts = buildWorkCountsQuery({
    sources: workItemSources, workspaceId: "workspace-ensaio", userId: "usuario-ensaio",
    companyIds: variant.companyIds, scope: variant.scope,
  });
  if (counts && await tryPrepare(counts.sql, `contadores ${variant.label}`)) unionPrepared += 1;

  for (const group of workItemGroups) {
    if (!group.key) continue;
    const grouped = buildWorkGroupQuery({
      sources: workItemSources, workspaceId: "workspace-ensaio", userId: "usuario-ensaio",
      companyIds: variant.companyIds, scope: variant.scope, group: group.key,
    });
    if (!grouped) continue;
    if (await tryPrepare(grouped.sql, `agrupamento ${group.key} / ${variant.label}`)) unionPrepared += 1;
  }
}

await client.query("ROLLBACK");
await client.end();

for (const failure of failures) console.error(`FALHA  ${failure}`);
console.log(`Central de Trabalho: ${prepared} consultas de fonte preparadas.`);
console.log(`Central de Trabalho: ${unionPrepared} consultas de união, contagem e agrupamento preparadas.`);
console.log(`Consultas nomeadas da IA: ${namedPrepared} preparadas.`);
console.log(`Total de falhas: ${failures.length}.`);
if (failures.length) process.exitCode = 1;
