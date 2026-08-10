/**
 * Driver PostgreSQL direto para desenvolvimento e teste local.
 *
 * Em produção a aplicação fala com o Neon por HTTP. Isso torna impossível rodar
 * o produto contra um PostgreSQL comum — e, sem isso, não há como reproduzir um
 * erro no navegador antes de corrigi-lo.
 *
 * Este módulo expõe exatamente o subconjunto da API do `neon(url, { fullResults: true })`
 * que a aplicação usa: `sql.query`, o template `sql\`...\`` e `sql.transaction`.
 * Ele é carregado por importação dinâmica e só entra em uso quando explicitamente
 * escolhido — o caminho de produção continua sendo o Neon, sem alteração.
 */
type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

/**
 * Descritor preguiçoso, igual ao do Neon.
 *
 * Este detalhe é o contrato inteiro: `sql.query(...)` **não** executa nada. Ele
 * descreve a consulta, que só roda quando é aguardada ou quando entra em
 * `transaction()`. Executar na criação faria os comandos de uma migration
 * dispararem fora da transação e fora de ordem.
 */
export type LocalQuery = { text: string; values: unknown[]; then?: unknown };

export type LocalSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): LocalQuery;
  query(text: string, values?: unknown[]): LocalQuery & PromiseLike<QueryResult>;
  transaction(queries: LocalQuery[], options?: { fullResults?: boolean }): Promise<QueryResult[]>;
  end(): Promise<void>;
};

type PgPool = {
  connect(): Promise<PgClient>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
};

type PgClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
};

function normalize(result: { rows: Record<string, unknown>[]; rowCount: number | null }): QueryResult {
  return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
}

export async function createLocalSql(connectionString: string): Promise<LocalSql> {
  // Importação dinâmica: `pg` é dependência de desenvolvimento e não entra no
  // caminho de produção, que continua usando o driver HTTP do Neon.
  const { Pool } = await import("pg") as unknown as { Pool: new (config: { connectionString: string; max: number }) => PgPool };
  const pool = new Pool({ connectionString, max: 10 });

  /** Consulta preguiçosa: descreve, não executa. Só roda ao ser aguardada. */
  const lazy = (text: string, values: unknown[]): LocalQuery => ({
    text,
    values,
    then(resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) {
      return pool.query(text, values).then((result) => resolve(normalize(result)), reject);
    },
  });

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]): LocalQuery => {
    const text = strings.reduce((acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ""), "");
    return lazy(text, values);
  }) as unknown as LocalSql;

  sql.query = ((text: string, values: unknown[] = []) => lazy(text, values)) as LocalSql["query"];

  sql.transaction = async (queries: LocalQuery[]) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results: QueryResult[] = [];
      for (const query of queries) {
        results.push(normalize(await client.query(query.text, query.values)));
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      // A transação inteira volta atrás: um `set_config` sem o comando que ele
      // protege seria pior que a falha original.
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  sql.end = () => pool.end();
  return sql;
}

/**
 * Decide qual driver usar.
 *
 * O padrão é sempre o Neon. O driver direto só entra quando pedido de forma
 * explícita (`FDP_DB_DRIVER=pg`) ou quando o banco é local — nunca por acidente
 * em produção.
 */
export function shouldUseLocalDriver(url: string) {
  const driver = String(process.env.FDP_DB_DRIVER ?? "").trim().toLowerCase();
  if (driver === "pg") return true;
  if (driver === "neon") return false;
  if (process.env.VERCEL) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
