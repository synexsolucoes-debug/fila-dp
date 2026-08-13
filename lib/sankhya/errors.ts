export class SankhyaConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requiresUserAction: boolean;
  readonly layoutRelated: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean; requiresUserAction?: boolean; layoutRelated?: boolean } = {}) {
    super(message);
    this.name = "SankhyaConnectorError";
    this.code = code.slice(0, 80);
    this.retryable = options.retryable === true;
    this.requiresUserAction = options.requiresUserAction === true;
    this.layoutRelated = options.layoutRelated === true;
  }
}

export function safeSankhyaError(error: unknown) {
  if (error instanceof SankhyaConnectorError) return error;
  const message = error instanceof Error ? error.message : "Falha inesperada no conector Sankhya.";
  const sanitized = message
    .replace(/(password|senha|token|cookie|authorization|secret)\s*[:=]?\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/[?&](?:token|password|senha|code)=[^&\s]+/giu, "[redacted]")
    .slice(0, 500);
  return new SankhyaConnectorError("SANKHYA_UNEXPECTED_ERROR", sanitized || "Falha inesperada no conector Sankhya.", { retryable: true });
}
