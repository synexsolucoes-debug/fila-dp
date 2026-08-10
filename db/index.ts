import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { createLocalSql, shouldUseLocalDriver, type LocalSql } from "./local-postgres";
import { del, get, put } from "@vercel/blob";
import { toPostgresParameters } from "../lib/postgres-parameters";
import { getPlatformContext } from "../lib/platform-context";
import { getTenantContext, type TenantContext } from "../lib/tenant-context";

type SqlValue = unknown;

type NeonSql = NeonQueryFunction<false, true>;

function isPostgresUrl(url: string) {
  return /^postgres(?:ql)?:\/\//i.test(url);
}

/** PostgreSQL-only adapter exposed through the application's prepared-query API. */
class NeonPreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly sql: NeonSql,
    private readonly query: string,
    private readonly args: SqlValue[] = [],
    /**
     * Contexto de tenant explícito.
     *
     * O contexto por AsyncLocalStorage não sobrevive ao retorno de uma função
     * `async`: quem chama volta a executar no contexto anterior ao `enterWith`.
     * Depender só dele deixava as consultas da rota sem `app.workspace_id`, e
     * com RLS ativo isso significa "nenhuma linha" — silenciosamente.
     * Por isso a conexão devolvida por `getWorkspaceContext` carrega o tenant.
     */
    private readonly boundContext: TenantContext | null = null,
  ) {}

  bind(...values: unknown[]) {
    return new NeonPreparedStatement(this.sql, this.query, values, this.boundContext);
  }

  private async execute() {
    const platformContext = getPlatformContext();
    if (platformContext) {
      const results = await this.sql.transaction([
        this.sql`SELECT set_config('app.platform_admin', 'true', true), set_config('app.user_id', ${platformContext.userId}, true)`,
        this.sql.query(toPostgresParameters(this.query), this.args),
      ] as never, { fullResults: true } as never);
      return results[1];
    }
    const context = this.boundContext ?? getTenantContext();
    if (!context) return this.sql.query(toPostgresParameters(this.query), this.args);
    const results = await this.sql.transaction([
      this.sql`SELECT set_config('app.workspace_id', ${context.workspaceId}, true), set_config('app.user_id', ${context.userId ?? ""}, true)`,
      this.sql.query(toPostgresParameters(this.query), this.args),
    ] as never, { fullResults: true } as never);
    return results[1];
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const result = await this.execute();
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (columnName) return (row[columnName] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.execute();
    return {
      results: result.rows as T[],
      success: true,
      meta: { changes: result.rowCount, rows_read: result.rows.length },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.execute();
    return {
      results: [],
      success: true,
      meta: { changes: result.rowCount, rows_written: result.rowCount },
    };
  }

  toNeonQuery() {
    return this.sql.query(toPostgresParameters(this.query), this.args);
  }
}

class NeonDatabase implements D1Database {
  constructor(private readonly sql: NeonSql, private readonly boundContext: TenantContext | null = null) {}

  prepare(query: string) {
    return new NeonPreparedStatement(this.sql, query, [], this.boundContext);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]) {
    const prepared = statements.map((statement) => {
      if (!(statement instanceof NeonPreparedStatement)) throw new Error("Comando de banco incompatível.");
      return statement.toNeonQuery();
    });
    const platformContext = getPlatformContext();
    const context = this.boundContext ?? getTenantContext();
    const transaction = platformContext
      ? [this.sql`SELECT set_config('app.platform_admin', 'true', true), set_config('app.user_id', ${platformContext.userId}, true)`, ...prepared]
      : context
      ? [this.sql`SELECT set_config('app.workspace_id', ${context.workspaceId}, true), set_config('app.user_id', ${context.userId ?? ""}, true)`, ...prepared]
      : prepared;
    const results = await this.sql.transaction(transaction as never, { fullResults: true } as never);
    const visibleResults = platformContext || context ? results.slice(1) : results;
    return visibleResults.map((result) => ({
      results: result.rows as T[],
      success: true,
      meta: { changes: result.rowCount, rows_read: result.rows.length, rows_written: result.rowCount },
    }));
  }
}

let neonDatabase: NeonDatabase | null = null;
let neonSql: NeonSql | null = null;

/**
 * Fachada síncrona sobre o driver PostgreSQL direto.
 *
 * `getD1()` é síncrono, mas abrir o pool local é assíncrono. As chamadas
 * resolvem o pool sob demanda — o comportamento visível é idêntico ao do Neon.
 */
function localSqlFacade(url: string): NeonSql {
  let pending: Promise<LocalSql> | null = null;
  const resolve = () => (pending ??= createLocalSql(url));

  // A consulta precisa continuar preguiçosa mesmo atrás da fachada: devolver uma
  // Promise aqui faria cada comando de um batch executar sozinho, fora da
  // transação — e cada um falharia por não enxergar o anterior.
  const lazy = (text: string, values: unknown[]) => ({
    text,
    values,
    then(onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) {
      return resolve().then((sql) => sql.query(text, values)).then(onFulfilled, onRejected);
    },
  });

  // A fachada imita a superfície do driver Neon; o `unknown` isola a conversão
  // em um ponto só, em vez de espalhar `any` pelo adaptador.
  const facade = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    lazy(strings.reduce((acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ""), ""), values)
  ) as unknown as Record<string, unknown>;
  facade.query = (text: string, args: unknown[] = []) => lazy(text, args);
  facade.transaction = async (queries: unknown[]) => (await resolve()).transaction(queries as never);
  return facade as unknown as NeonSql;
}

function getNeonSql() {
  if (neonSql) return neonSql;
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
  if (!url || !isPostgresUrl(url)) {
    throw new Error("Banco não configurado. Defina DATABASE_URL com uma conexão PostgreSQL/Neon.");
  }
  neonSql = shouldUseLocalDriver(url) ? localSqlFacade(url) : neon(url, { fullResults: true });
  return neonSql;
}

export function getD1(): D1Database {
  if (!neonDatabase) neonDatabase = new NeonDatabase(getNeonSql());
  return neonDatabase;
}

/**
 * Conexão com o tenant preso na instância.
 *
 * Toda consulta feita por aqui envia `app.workspace_id` junto, na mesma
 * transação — não há caminho para uma consulta de rota escapar do isolamento
 * porque o contexto assíncrono se perdeu no meio do caminho.
 */
export function getScopedD1(context: TenantContext): D1Database {
  return new NeonDatabase(getNeonSql(), context);
}

type VercelBlobObject = R2ObjectBody;

function privateBlobObject(result: Awaited<ReturnType<typeof get>>): VercelBlobObject | null {
  if (!result || result.statusCode !== 200 || !result.stream || result.blob.size === null) return null;
  return {
    body: result.stream,
    size: result.blob.size,
    etag: result.blob.etag,
    httpMetadata: {
      contentType: result.blob.contentType,
      contentDisposition: result.blob.contentDisposition,
    },
    writeHttpMetadata(headers: Headers) {
      if (result.blob.contentType) headers.set("Content-Type", result.blob.contentType);
      if (result.blob.contentDisposition) headers.set("Content-Disposition", result.blob.contentDisposition);
    },
  };
}

class VercelBlobBucket implements R2Bucket {
  async get(key: string) {
    const result = await get(key, { access: "private", useCache: false });
    return privateBlobObject(result);
  }

  async put(key: string, value: ReadableStream | ArrayBuffer | Blob, options?: { httpMetadata?: { contentType?: string; contentDisposition?: string }; customMetadata?: Record<string, string> }) {
    await put(key, value, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: options?.httpMetadata?.contentType,
    });
  }

  async delete(key: string) {
    await del(key);
  }
}

const attachmentsBucket = new VercelBlobBucket();

export function getAttachmentsBucket(): R2Bucket {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Armazenamento de anexos não configurado. Conecte um Blob privado ao projeto Vercel.");
  }
  return attachmentsBucket;
}
