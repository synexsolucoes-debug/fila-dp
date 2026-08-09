/**
 * Logs estruturados com correlação.
 *
 * Um log só é útil em produção se der para responder "qual requisição, de qual
 * workspace, em qual execução". Por isso todo evento carrega os identificadores
 * de correlação do §83 e nunca carrega PII: nomes, e-mails, CPF, valores de
 * campo e corpo de requisição ficam de fora por construção.
 */
export type LogContext = {
  requestId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  connectorId?: string | null;
  syncRunId?: string | null;
  jobId?: string | null;
  deliveryId?: string | null;
  apiKeyId?: string | null;
  route?: string | null;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

const correlationKeys = [
  "requestId", "workspaceId", "userId", "connectorId", "syncRunId", "jobId", "deliveryId", "apiKeyId", "route",
] as const;

/** Campos que jamais entram em log, mesmo se alguém os passar por engano. */
const forbiddenKeys = new Set([
  "email", "name", "fullname", "cpf", "cpfhash", "password", "token", "secret", "authorization",
  "pix", "pixkey", "bankaccount", "payout", "credential", "signature", "body", "payload",
]);

function safeValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 200);
  if (Array.isArray(value)) return value.slice(0, 20).map(safeValue);
  return undefined;
}

/** Remove qualquer chave sensível antes de serializar. */
export function redactLogFields(fields: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (forbiddenKeys.has(key.toLowerCase())) continue;
    const projected = safeValue(value);
    if (projected !== undefined) safe[key] = projected;
  }
  return safe;
}

export function log(level: LogLevel, event: string, context: LogContext = {}, fields: Record<string, unknown> = {}) {
  const entry: Record<string, unknown> = {
    level,
    event,
    service: "fila-dp",
    timestamp: new Date().toISOString(),
  };
  for (const key of correlationKeys) {
    const value = context[key];
    if (value) entry[key] = String(value).slice(0, 120);
  }
  Object.assign(entry, redactLogFields(fields));
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  return entry;
}

/** Identificador de correlação da requisição: reaproveita o recebido ou cria um novo. */
export function requestIdFrom(request: Request) {
  const received = request.headers.get("x-fila-dp-request-id") ?? request.headers.get("x-request-id");
  if (received && /^[A-Za-z0-9_:-]{8,120}$/u.test(received)) return received;
  return crypto.randomUUID();
}

/** Mede duração sem vazar conteúdo: só o nome da operação e o tempo. */
export async function observe<T>(
  event: string,
  context: LogContext,
  operation: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    log("info", event, context, { ...fields, outcome: "success", durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    log("error", event, context, {
      ...fields,
      outcome: "failure",
      durationMs: Date.now() - startedAt,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code).slice(0, 60) : undefined,
    });
    throw error;
  }
}
