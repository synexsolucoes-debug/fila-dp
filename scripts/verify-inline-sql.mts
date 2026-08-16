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
  let approximated = 0;
  let skipped = 0;

  /**
   * Substituições para o trecho interpolado.
   *
   * A primeira versão disto era teatro: tentava `?`, `true`, `1` e contava como
   * verificada a consulta em que alguma delas preparasse. Testei introduzindo
   * uma coluna inexistente no trecho *fixo* de um INSERT em lote — o relatório
   * continuou dizendo "0 falhas". Nenhuma candidata servia para `VALUES ${...}`,
   * a consulta caía em "não verificada", e "não verificada" não reprovava. Ou
   * seja: exatamente o defeito que este projeto vem corrigindo em outras
   * ferramentas — dizer OK sobre o que não se olhou.
   *
   * A versão que vale sabe o formato. Num INSERT a aridade da tupla está na
   * própria lista de colunas, e é ela que torna a substituição exata o
   * bastante para o PostgreSQL validar tabela e colunas.
   */
  function substituicoes(sql: string) {
    const insert = /INSERT\s+INTO\s+[\w".]+\s*\(([^)]*)\)\s*(?:\n|\s)*VALUES\s*\$\{\.\.\.\}/iu.exec(sql);
    if (insert) {
      const colunas = insert[1].split(",").filter((parte) => parte.trim()).length;
      const tupla = `(${Array.from({ length: colunas }, () => "?").join(", ")})`;
      return [tupla, `${tupla}, ${tupla}`];
    }
    // `IN (${ids.map(() => "?").join(",")})`, `WHERE ${where.join(" AND ")}`,
    // e o resto: uma lista curta cobre as formas que aparecem no produto.
    return ["?", "true", "1", "'x'", "?, ?", "id"];
  }

  await client.query("BEGIN");
  for (const [index, query] of queries.entries()) {
    if (query.interpolated) {
      let ok = false;
      for (const candidata of substituicoes(query.sql)) {
        const tentativa = toPostgresParameters(query.sql.replaceAll("${...}", candidata));
        await client.query(`SAVEPOINT inline_sql_${index}`);
        try {
          await client.query(`PREPARE inline_sql_${index} AS ${tentativa}`);
          await client.query(`RELEASE SAVEPOINT inline_sql_${index}`);
          ok = true;
          break;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT inline_sql_${index}`);
          if (String((error as { code?: string }).code ?? "") === INDETERMINATE_PARAMETER) { ok = true; break; }
        }
      }
      if (ok) approximated += 1; else skipped += 1;
      continue;
    }
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
  console.log(`\nConsultas preparadas: ${prepared} | interpoladas verificadas por aproximação: ${approximated} | não verificadas: ${skipped} | falhas: ${failures.length}`);

  /**
   * Teto do que fica sem verificação.
   *
   * Sem ele, uma consulta interpolada que quebra apenas *sai* da contagem de
   * verificadas e entra na de não verificadas — o relatório muda dois números
   * e continua dizendo "0 falhas". Foi o que aconteceu quando testei este
   * verificador contra uma coluna inexistente: ele notou e não reprovou.
   *
   * Com o teto, quebrar uma consulta que hoje é verificável reprova o build.
   * Tornar mais uma verificável é livre — e obriga a baixar o número aqui,
   * senão o teste de folga acusa.
   */
  const MAXIMO_NAO_VERIFICADAS = 24;
  if (skipped > MAXIMO_NAO_VERIFICADAS) {
    console.error(`\nRegressão de cobertura: ${skipped} consultas sem verificação, o teto é ${MAXIMO_NAO_VERIFICADAS}.`);
    console.error("Uma consulta que era verificável deixou de ser — provavelmente ela quebrou.");
    process.exitCode = 1;
  }
  if (failures.length) process.exitCode = 1;
}

await main();
