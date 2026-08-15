import { fileURLToPath } from "node:url";
import { collectQueries } from "./inline-sql.mjs";
import { toPostgresParameters } from "../lib/postgres-parameters.ts";

/**
 * Prepara contra o PostgreSQL real todas as consultas escritas no código.
 *
 * A verificação estática de palavra reservada pega a classe de erro que derrubou
 * a varredura das integrações, mas ela é textual: não sabe se a coluna existe,
 * se o `JOIN` fecha, se o nome da tabela está certo. `PREPARE` sabe — o
 * planejador resolve nomes e tipos sem executar nada, então uma coluna que não
 * existe ou um parêntese a menos aparecem aqui, e não no cliente.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node --experimental-strip-types scripts/verify-inline-sql.mts
 *
 * O banco precisa estar com as migrations aplicadas (`npm run db:migrate`).
 * Nada é executado nem escrito: só `PREPARE`, dentro de uma transação que sofre
 * ROLLBACK no fim.
 */

/** O planejador não infere tipo de todo parâmetro; isso não é defeito da consulta. */
const INDETERMINATE_PARAMETER = "42P18";

type Failure = { file: string; line: number; code: string; message: string; sql: string };

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
  if (!databaseUrl?.startsWith("postgres")) {
    throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL com as migrations aplicadas.");
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const root = fileURLToPath(new URL("..", import.meta.url));
  const queries = collectQueries(root);
  const failures: Failure[] = [];
  let prepared = 0;
  let skipped = 0;

  await client.query("BEGIN");
  for (const [index, query] of queries.entries()) {
    // Consulta montada com interpolação não existe como texto fixo: o que o
    // banco receberia depende de valores de execução. Fica de fora, e o total é
    // reportado para que ninguém confunda "não verificado" com "verificado".
    if (query.interpolated) { skipped += 1; continue; }
    const statement = toPostgresParameters(query.sql);
    // Um SAVEPOINT por consulta. Sem ele, a primeira falha aborta a transação e
    // todas as consultas seguintes reportam `25P02` — o relatório passaria a
    // acusar centenas de defeitos inexistentes e esconderia o verdadeiro.
    await client.query(`SAVEPOINT inline_sql_${index}`);
    try {
      await client.query(`PREPARE inline_sql_${index} AS ${statement}`);
      await client.query(`RELEASE SAVEPOINT inline_sql_${index}`);
      prepared += 1;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT inline_sql_${index}`);
      const code = String((error as { code?: string }).code ?? "");
      if (code === INDETERMINATE_PARAMETER) { prepared += 1; continue; }
      failures.push({
        file: query.file,
        line: query.line,
        code,
        message: String((error as { message?: string }).message ?? error).split("\n")[0],
        sql: query.sql.replace(/\s+/gu, " ").slice(0, 160),
      });
    }
  }
  await client.query("ROLLBACK");
  await client.end();

  for (const failure of failures) {
    console.error(`\n${failure.file}:${failure.line}  [${failure.code}] ${failure.message}\n  ${failure.sql}`);
  }
  console.log(`\nConsultas preparadas: ${prepared} | com interpolação (não verificadas): ${skipped} | falhas: ${failures.length}`);
  if (failures.length) process.exitCode = 1;
}

await main();
