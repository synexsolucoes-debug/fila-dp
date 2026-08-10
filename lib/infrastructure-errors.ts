/**
 * Classificação de falhas de infraestrutura.
 *
 * "Não foi possível concluir a operação." é a resposta certa para um defeito
 * inesperado: não vaza SQL, tabela nem stack trace. Mas ela também era a
 * resposta para falhas *operacionais* — banco atrás da versão da aplicação,
 * banco inacessível, configuração ausente. Nesses casos o texto genérico não
 * ajuda ninguém: o cliente não sabe que não é culpa dele, e quem opera não sabe
 * o que corrigir.
 *
 * Este módulo separa as duas coisas. A mensagem devolvida diz o que aconteceu em
 * termos operacionais — sem nome de tabela, sem comando, sem credencial.
 */

/** Estados do PostgreSQL que indicam schema atrás da aplicação. */
const SCHEMA_DRIFT_STATES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42883", // undefined_function
  "42704", // undefined_object (tipo, enum, índice)
  "3F000", // invalid_schema_name
]);

/** Estados e sinais de banco inacessível ou recusando conexão. */
const UNAVAILABLE_STATES = new Set([
  "08000", "08003", "08006", "08001", "08004", // classe connection_exception
  "57P01", "57P02", "57P03", // desligamento do servidor
  "53300", // too_many_connections
  "3D000", // invalid_catalog_name
  "28P01", "28000", // autenticação recusada
]);

const UNAVAILABLE_PATTERNS = [
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/u,
  /fetch failed|failed to fetch|network error/iu,
  /Banco não configurado/u,
];

/** Papel da aplicação sem privilégio sobre parte do schema. */
const PERMISSION_STATES = new Set([
  "42501", // insufficient_privilege
]);

export type InfrastructureFault = {
  status: number;
  code: "SCHEMA_OUTDATED" | "DATABASE_UNAVAILABLE" | "DATABASE_PERMISSION_DENIED";
  message: string;
  /** Rótulo curto para o log, sem conteúdo sensível. */
  reason: string;
};

function errorCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

/**
 * Reconhece a falha operacional por trás do erro, ou devolve `null` quando o
 * erro é de fato inesperado e deve seguir pelo caminho genérico.
 */
export function classifyInfrastructureFault(error: unknown): InfrastructureFault | null {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (SCHEMA_DRIFT_STATES.has(code)) {
    return {
      status: 503,
      code: "SCHEMA_OUTDATED",
      // Diz o que precisa acontecer, sem revelar qual objeto faltou.
      message: "O banco de dados está atrás da versão desta aplicação. Um administrador precisa aplicar as migrações pendentes antes que a operação volte.",
      reason: `schema_drift:${code}`,
    };
  }

  if (PERMISSION_STATES.has(code)) {
    return {
      status: 503,
      code: "DATABASE_PERMISSION_DENIED",
      // Acontece quando uma versão nova cria objetos e o papel da aplicação
      // fica sem privilégio sobre eles. É indistinguível de "quebrou" para quem
      // usa — e a correção é de quem administra o banco, não do cliente.
      message: "O acesso do aplicativo ao banco de dados está incompleto. Um administrador precisa regularizar as permissões do papel usado pela aplicação.",
      reason: `permission_denied:${code}`,
    };
  }

  if (UNAVAILABLE_STATES.has(code) || UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      message: "O sistema não está conseguindo falar com o banco de dados. Tente novamente em alguns instantes; se persistir, avise o administrador.",
      reason: code ? `unavailable:${code}` : "unavailable:network",
    };
  }

  return null;
}
