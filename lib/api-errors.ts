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
  const requestId = crypto.randomUUID();
  console.error("[fila-dp][api] unexpected error", { requestId, error });
  return Response.json(
    { error: "Não foi possível concluir a operação.", code: "INTERNAL_ERROR", requestId },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
