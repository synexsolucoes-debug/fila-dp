import { getChatGPTUser } from "@/app/chatgpt-auth";
import { ApiError, apiErrorResponse } from "./api-errors";

export { ApiError } from "./api-errors";

export async function getApiUser() {
  const user = await getChatGPTUser();
  if (!user) {
    return {
      user: null,
      response: Response.json({ error: "Autenticação necessária." }, { status: 401 }),
    } as const;
  }
  return { user, response: null } as const;
}

export function apiError(error: unknown) {
  return apiErrorResponse(error);
}

export function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function validProcessType(value: unknown, fallback = "OUTROS") {
  const processType = text(value, 40).toUpperCase() || fallback;
  if (processType === "ADMISSÃO" || processType === "ADMISSAO" || processType === "ADMISSÃO DIGITAL" || processType === "ADMISSAO DIGITAL") {
    throw ApiError.badRequest("Processo de admissão inválido: a admissão digital é realizada integralmente pela Sólides. Use Conciliação cadastral apenas para integrar dados concluídos ao ERP.", "INVALID_PROCESS_TYPE");
  }
  return processType;
}

export function validDate(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw ApiError.badRequest("Data inválida.", "INVALID_DATE");
  }
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw ApiError.badRequest("Data inválida.", "INVALID_DATE");
  return value;
}

export function validDueAt(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw ApiError.badRequest("Prazo inválido.", "INVALID_DUE_AT");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validDate(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw ApiError.badRequest("Prazo inválido.", "INVALID_DUE_AT");
  const date = new Date(`${value}:00`);
  if (Number.isNaN(date.getTime())) throw ApiError.badRequest("Prazo inválido.", "INVALID_DUE_AT");
  return value;
}

export function computeSlaStatus(dueAt: string | null, behavior: string) {
  if (behavior === "paused") return "paused";
  if (behavior === "completed") return "completed";
  if (!dueAt) return "safe";
  const today = new Date().toISOString().slice(0, 10);
  if (dueAt < today) return "overdue";
  if (dueAt === today) return "warning";
  return "safe";
}
