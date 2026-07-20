import { createClient, type Client, type InArgs } from "@libsql/client";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/libsql";
import { del, get, put } from "@vercel/blob";
import * as schema from "./schema";

type SqlValue = unknown;

type NeonSql = NeonQueryFunction<false, true>;

function isPostgresUrl(url: string) {
  return /^postgres(?:ql)?:\/\//i.test(url);
}

/**
 * Converts the small SQLite/D1 SQL dialect used by the app to PostgreSQL.
 * Keeping this at the adapter boundary means the API routes can remain
 * provider-agnostic while we move the production database to Neon.
 */
function normalizePostgresSql(source: string) {
  let sql = source.trim();

  if (/^PRAGMA\s+table_info\s*\(/i.test(sql)) {
    const table = sql.match(/^PRAGMA\s+table_info\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*;?$/i)?.[1];
    if (table) {
      return `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}'`;
    }
  }

  const hasIgnore = /^INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  sql = sql.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");

  if (/^INSERT\s+OR\s+REPLACE\s+INTO\b/i.test(sql)) {
    sql = sql.replace(/^INSERT\s+OR\s+REPLACE\s+INTO\b/i, "INSERT INTO");
    if (!/\bON\s+CONFLICT\b/i.test(sql)) {
      sql += " ON CONFLICT (user_id) DO UPDATE SET active_workspace_id = EXCLUDED.active_workspace_id, active_board_id = EXCLUDED.active_board_id, updated_at = EXCLUDED.updated_at";
    }
  }

  sql = sql.replace(/datetime\(\s*'now'\s*,\s*'-(\d+)\s+(minutes?|hours?|days?)'\s*\)/gi, (_match, amount: string, unit: string) => {
    const normalizedUnit = unit.toLowerCase().replace(/s$/, "") + "s";
    return `(CURRENT_TIMESTAMP - INTERVAL '${amount} ${normalizedUnit}')::text`;
  });
  sql = sql.replace(/\bCURRENT_TIMESTAMP\b(?!\s*-\s*INTERVAL)/g, "CURRENT_TIMESTAMP::text");

  if (hasIgnore && !/\bON\s+CONFLICT\b/i.test(sql)) {
    const semicolon = /;\s*$/.test(sql) ? ";" : "";
    sql = sql.replace(/;\s*$/, "");
    sql += " ON CONFLICT DO NOTHING" + semicolon;
  }

  // D1 uses positional question marks; node-postgres/Neon uses $1, $2, ...
  let parameter = 0;
  let quote: "'" | '"' | "`" | null = null;
  let result = "";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (quote) {
      result += character;
      if (character === quote) {
        if (next === quote) {
          result += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += character;
    } else if (character === "?") {
      parameter += 1;
      result += `$${parameter}`;
    } else {
      result += character;
    }
  }
  return result;
}

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
    return this.sql.query(normalizePostgresSql(this.query), this.args);
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
    return this.sql.query(normalizePostgresSql(this.query), this.args);
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
    const results = await this.sql.transaction(prepared as never, { fullResults: true } as never);
    return results.map((result) => ({
      results: result.rows as T[],
      success: true,
      meta: { changes: result.rowCount, rows_read: result.rows.length, rows_written: result.rowCount },
    }));
  }
}

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
let neonDatabase: NeonDatabase | null = null;
let neonSql: NeonSql | null = null;

function getClient() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL ?? (process.env.VERCEL ? "" : "file:./fila-dp.sqlite");
  if (!url) {
    throw new Error("Banco não configurado. Defina DATABASE_URL (Neon) no projeto Vercel.");
  }
  client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    intMode: "number",
  });
  return client;
}

function getNeonSql() {
  if (neonSql) return neonSql;
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
  if (!url || !isPostgresUrl(url)) {
    throw new Error("Banco Neon não configurado. Conecte o Neon à Vercel e defina DATABASE_URL.");
  }
  neonSql = neon(url, { fullResults: true });
  return neonSql;
}

export function getDb() {
  return drizzle(getClient(), { schema });
}

export function getD1(): D1Database {
  const configuredUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL ?? process.env.TURSO_DATABASE_URL;
  if (configuredUrl && isPostgresUrl(configuredUrl)) {
    if (!neonDatabase) neonDatabase = new NeonDatabase(getNeonSql());
    return neonDatabase;
  }
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
