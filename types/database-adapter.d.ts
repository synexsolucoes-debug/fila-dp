/**
 * Contrato do adaptador de banco do produto.
 *
 * O Vinculato roda em PostgreSQL, mas a interface do adaptador nasceu no
 * Cloudflare D1 e ficou com o nome dele: `D1Database`, `D1PreparedStatement`,
 * `D1Result`. O nome não é detalhe cosmético — ele fez a documentação e o
 * onboarding afirmarem, por anos, uma tecnologia que o produto não usa, e
 * qualquer pessoa nova gastava um tempo procurando o D1 que não existe.
 *
 * O que **não** muda aqui, de propósito: o formato. `prepare().bind().first()`
 * continua idêntico, e nenhuma consulta foi reescrita. Trocar o adaptador por
 * estética seria justamente o que §4 proíbe; trocar o nome que mente é outra
 * coisa.
 *
 * Os nomes antigos continuam válidos como apelido para que a migração aconteça
 * por arquivo, sem um commit gigante que ninguém consegue revisar (§47).
 */

interface SqlResult<T = unknown> {
  results: T[];
  success: boolean;
  meta: {
    changes: number;
    duration?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
  };
}

interface SqlPreparedStatement {
  bind(...values: unknown[]): SqlPreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
}

interface SqlDatabase {
  prepare(query: string): SqlPreparedStatement;
  /** Executa tudo em uma transação: o lote é a unidade de atomicidade do produto. */
  batch<T = Record<string, unknown>>(statements: SqlPreparedStatement[]): Promise<SqlResult<T>[]>;
}

/** @deprecated Nome herdado do D1; use `SqlResult`. */
type D1Result<T = unknown> = SqlResult<T>;
/** @deprecated Nome herdado do D1; use `SqlPreparedStatement`. */
type D1PreparedStatement = SqlPreparedStatement;
/** @deprecated Nome herdado do D1; use `SqlDatabase`. */
type D1Database = SqlDatabase;

/**
 * Contrato do armazenamento de anexos.
 *
 * Mesma história do adaptador de banco: o produto guarda anexos no Vercel Blob
 * privado, e a interface se chamava `R2Bucket`. O formato é o mesmo — quatro
 * operações e os metadados HTTP que a rota de download precisa devolver.
 */
interface ObjectStorageBody {
  body: ReadableStream;
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string; contentDisposition?: string };
  writeHttpMetadata(headers: Headers): void;
}

interface ObjectStorageBucket {
  get(key: string): Promise<ObjectStorageBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Blob,
    options?: {
      httpMetadata?: { contentType?: string; contentDisposition?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** @deprecated Nome herdado do R2; use `ObjectStorageBody`. */
type R2ObjectBody = ObjectStorageBody;
/** @deprecated Nome herdado do R2; use `ObjectStorageBucket`. */
type R2Bucket = ObjectStorageBucket;
