import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { del, get, put } from "@vercel/blob";
import { toPostgresParameters } from "../lib/postgres-parameters";
import { getTenantContext } from "../lib/tenant-context";

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
  ) {}

  bind(...values: unknown[]) {
    return new NeonPreparedStatement(this.sql, this.query, values);
  }

  private async execute() {
    const context = getTenantContext();
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
  constructor(private readonly sql: NeonSql) {}

  prepare(query: string) {
    return new NeonPreparedStatement(this.sql, query);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]) {
    const prepared = statements.map((statement) => {
      if (!(statement instanceof NeonPreparedStatement)) throw new Error("Comando de banco incompatível.");
      return statement.toNeonQuery();
    });
    const context = getTenantContext();
    const transaction = context
      ? [this.sql`SELECT set_config('app.workspace_id', ${context.workspaceId}, true), set_config('app.user_id', ${context.userId ?? ""}, true)`, ...prepared]
      : prepared;
    const results = await this.sql.transaction(transaction as never, { fullResults: true } as never);
    const visibleResults = context ? results.slice(1) : results;
    return visibleResults.map((result) => ({
      results: result.rows as T[],
      success: true,
      meta: { changes: result.rowCount, rows_read: result.rows.length, rows_written: result.rowCount },
    }));
  }
}

let neonDatabase: NeonDatabase | null = null;
let neonSql: NeonSql | null = null;

function getNeonSql() {
  if (neonSql) return neonSql;
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
  if (!url || !isPostgresUrl(url)) {
    throw new Error("Banco Neon não configurado. Conecte o Neon à Vercel e defina DATABASE_URL.");
  }
  neonSql = neon(url, { fullResults: true });
  return neonSql;
}

export function getD1(): D1Database {
  if (!neonDatabase) neonDatabase = new NeonDatabase(getNeonSql());
  return neonDatabase;
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
