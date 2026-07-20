import { getChatGPTUser } from "@/app/chatgpt-auth";

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
  const message = error instanceof Error ? error.message : "Erro inesperado.";
  const status = message.includes("permissão") ? 403 : message.includes("não encontrad") ? 404 : message.includes("inválid") ? 400 : 500;
  return Response.json({ error: message }, { status });
}

export function text(value: unknown, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function validDate(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Data inválida.");
  }
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
