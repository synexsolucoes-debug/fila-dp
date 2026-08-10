/**
 * Ponte HTTP compatível com o driver `@neondatabase/serverless`.
 *
 * Existe por um motivo só: em produção a aplicação fala com o banco pelo driver
 * HTTP do Neon, e todo o isolamento multi-tenant depende de `set_config` e a
 * consulta caírem na MESMA transação. Validar isso apenas com o driver
 * PostgreSQL local prova a semântica do PostgreSQL, não a do caminho de
 * produção.
 *
 * Esta ponte implementa o contrato do driver — verificado lendo o próprio
 * `node_modules/@neondatabase/serverless/index.mjs`, não suposto:
 *
 *   requisição individual : { query, params }
 *   requisição em lote    : { queries: [{ query, params }, ...] }
 *   resposta individual   : { fields, rows, rowCount, command, rowAsArray }
 *   resposta em lote      : { results: [ ...respostas individuais... ] }
 *
 * Cabeçalhos usados pelo driver: `Neon-Raw-Text-Output: true` (todo valor volta
 * como texto e quem converte é o cliente) e `Neon-Array-Mode: true` (cada linha
 * é um array na ordem de `fields`).
 *
 * É ferramenta de teste. Não vai para produção e não substitui o Neon: ela
 * prova que o driver, com a nossa forma de uso, entrega o `set_config` junto da
 * consulta dentro de uma transação.
 *
 * Uso:
 *   FDP_BRIDGE_DATABASE_URL=postgres://user@host/db node scripts/neon-http-bridge.mjs
 */
import { createServer } from "node:http";
import pg from "pg";

const databaseUrl = process.env.FDP_BRIDGE_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina FDP_BRIDGE_DATABASE_URL com o PostgreSQL de destino da ponte.");
}
const port = Number(process.env.FDP_BRIDGE_PORT ?? 5599);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });

/**
 * O driver pede texto cru (`Neon-Raw-Text-Output: true`) e faz a conversão de
 * tipo do lado do cliente, usando `fields[].dataTypeID`.
 *
 * Sem desligar os conversores do `pg`, um `jsonb` chegaria aqui já convertido
 * em objeto JavaScript e seria re-serializado errado — um array viraria
 * "a,b,c" em vez de '["a","b","c"]', e o cliente quebraria ao fazer JSON.parse.
 */
const rawTextTypes = { getTypeParser: () => (value) => value };
const textResultFormat = { rowMode: "array", types: rawTextTypes };

function shape(result) {
  return {
    command: result.command ?? "SELECT",
    rowCount: result.rowCount ?? 0,
    rowAsArray: true,
    fields: (result.fields ?? []).map((field) => ({
      name: field.name,
      dataTypeID: field.dataTypeID,
      tableID: field.tableID,
      columnID: field.columnID,
      dataTypeSize: field.dataTypeSize,
      dataTypeModifier: field.dataTypeModifier,
      format: "text",
    })),
    // Os valores já vêm como texto do PostgreSQL; converter aqui os corromperia.
    rows: (result.rows ?? []).map((row) => row.map((value) => (value === null ? null : String(value)))),
  };
}

async function runSingle({ query, params }) {
  const result = await pool.query({ text: query, values: params ?? [], ...textResultFormat });
  return shape(result);
}

/**
 * Lote: uma transação, uma conexão, na ordem recebida.
 *
 * É exatamente esta garantia que o isolamento do produto usa — o `set_config`
 * do workspace precisa valer para a consulta seguinte.
 */
async function runBatch(queries, isolationLevel) {
  const client = await pool.connect();
  try {
    await client.query(isolationLevel ? `BEGIN ISOLATION LEVEL ${isolationLevel}` : "BEGIN");
    const results = [];
    for (const item of queries) {
      const result = await client.query({ text: item.query, values: item.params ?? [], ...textResultFormat });
      results.push(shape(result));
    }
    await client.query("COMMIT");
    return results;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end("method not allowed");
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const isolation = request.headers["neon-batch-isolation-level"];
      const payload = Array.isArray(body.queries)
        ? { results: await runBatch(body.queries, typeof isolation === "string" ? isolation : undefined) }
        : await runSingle(body);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
    } catch (error) {
      // O driver trata 400 como erro de banco e propaga a mensagem.
      response.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ message: String(error?.message ?? error), code: error?.code, severity: error?.severity }));
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ponte Neon HTTP em http://127.0.0.1:${port} → ${databaseUrl.replace(/:[^:@/]*@/u, ":***@")}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { server.close(); void pool.end(); process.exit(0); });
}
