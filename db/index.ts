import { createClient, type Client, type InArgs } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { del, get, put } from "@vercel/blob";
import * as schema from "./schema";

type SqlValue = unknown;

class LibsqlPreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly client: Client,
    private readonly sql: string,
    private readonly args: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new LibsqlPreparedStatement(this.client, this.sql, values);
  }

  private statement() {
    return { sql: this.sql, args: this.args as InArgs };
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const result = await this.client.execute(this.statement());
    const row = result.rows[0];
    if (!row) return null;
    if (columnName) return (row[columnName] as T) ?? null;
    return row as unknown as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.client.execute(this.statement());
    return {
      results: result.rows as unknown as T[],
      success: true,
      meta: {
        changes: result.rowsAffected,
        last_row_id: result.lastInsertRowid ? Number(result.lastInsertRowid) : undefined,
        rows_read: result.rows.length,
      },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.client.execute(this.statement());
    return {
      results: [],
      success: true,
      meta: {
        changes: result.rowsAffected,
        last_row_id: result.lastInsertRowid ? Number(result.lastInsertRowid) : undefined,
        rows_written: result.rowsAffected,
      },
    };
  }

  toLibsqlStatement() {
    return this.statement();
  }
}

class LibsqlDatabase implements D1Database {
  constructor(private readonly client: Client) {}

  prepare(query: string) {
    return new LibsqlPreparedStatement(this.client, query);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]) {
    const sqlStatements = statements.map((statement) => {
      if (!(statement instanceof LibsqlPreparedStatement)) throw new Error("Comando de banco incompatível.");
      return statement.toLibsqlStatement();
    });
    const results = await this.client.batch(sqlStatements, "write");
    return results.map((result) => ({
      results: result.rows as unknown as T[],
      success: true,
      meta: {
        changes: result.rowsAffected,
        last_row_id: result.lastInsertRowid ? Number(result.lastInsertRowid) : undefined,
        rows_read: result.rows.length,
        rows_written: result.rowsAffected,
      },
    }));
  }
}

let client: Client | null = null;
let database: LibsqlDatabase | null = null;

function getClient() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL ?? process.env.DATABASE_URL ?? (process.env.VERCEL ? "" : "file:./fila-dp.sqlite");
  if (!url) {
    throw new Error("Banco não configurado. Defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN no projeto Vercel.");
  }
  client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    intMode: "number",
  });
  return client;
}

export function getDb() {
  return drizzle(getClient(), { schema });
}

export function getD1(): D1Database {
  if (!database) database = new LibsqlDatabase(getClient());
  return database;
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
