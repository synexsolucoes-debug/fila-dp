import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { handOverToBackup } from "@/lib/portfolio-service";

/** "Passar abertas para o backup": as demandas em aberto da pessoa vão para o backup de cada empresa. */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "repassar demandas ao backup");
    const userId = cleanText(body.userId, 120);
    if (!userId) throw ApiError.badRequest("Selecione de quem são as demandas.", "HANDOVER_USER_REQUIRED");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const result = await handOverToBackup(d1, workspace.id, {
      userId: user.id, email: auth.user.email, requestId: request.headers.get("x-fila-dp-request-id"),
    }, userId, access.unrestricted ? null : access.companyIds);
    return Response.json(result);
  } catch (error) { return apiError(error); }
}
