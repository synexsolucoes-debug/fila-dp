import { log } from "./observability.ts";
import { classifyInfrastructureFault } from "./infrastructure-errors.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, code = "INVALID_REQUEST") {
    return new ApiError(400, code, message);
  }

  static forbidden(message = "Você não tem permissão para realizar esta ação.", code = "FORBIDDEN") {
    return new ApiError(403, code, message);
  }

  static notFound(message: string, code = "NOT_FOUND") {
    return new ApiError(404, code, message);
  }
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json(
      { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const databaseMessage = error instanceof Error ? error.message : String(error ?? "");
  if (databaseMessage.includes("EPI_INSUFFICIENT_STOCK")) {
    return Response.json({
      error: "O local de estoque não possui saldo suficiente. Registre uma entrada ou escolha outro local.",
      code: "EPI_INSUFFICIENT_STOCK",
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  if (databaseMessage.includes("EPI_STOCK_LOCATION_NOT_FOUND")) {
    return Response.json({ error: "O local de estoque não existe ou está inativo.", code: "EPI_STOCK_LOCATION_NOT_FOUND" },
      { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const requestId = crypto.randomUUID();

  // Falha operacional conhecida (banco desatualizado, banco fora do ar) recebe
  // uma resposta que diz o que houve. Continua sem SQL, sem nome de tabela e sem
  // stack trace — o que muda é o cliente saber que não é erro dele e o operador
  // saber o que corrigir.
  const fault = classifyInfrastructureFault(error);
  if (fault) {
    log("error", "api.infrastructure_fault", { requestId }, {
      faultCode: fault.code,
      reason: fault.reason,
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
    });
    return Response.json(
      { error: fault.message, code: fault.code, requestId },
      { status: fault.status, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
    );
  }

  log("error", "api.unhandled_error", { requestId }, {
    errorName: error instanceof Error ? error.name : "UnknownError",
    // A mensagem fica só no servidor; o cliente recebe apenas o requestId.
    errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
  return Response.json(
    { error: "Não foi possível concluir a operação.", code: "INTERNAL_ERROR", requestId },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
