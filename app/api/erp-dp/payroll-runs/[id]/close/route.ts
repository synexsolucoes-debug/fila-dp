import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { closeRun } from "@/lib/payroll-run-service";

type RouteContext = { params: Promise<{ id: string }> };

/** Fecha a folha da competência: o resultado não muda mais, e os retroativos pagos nela saem como lançados. */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.manage");
    const run = await d1.prepare("SELECT company_id FROM fdp_payroll_runs WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<{ company_id: string }>();
    if (!run) throw ApiError.notFound("Folha não encontrada.", "PAYROLL_RUN_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, run.company_id);
    const result = await closeRun(d1, { workspaceId: workspace.id, runId: id, userId: user.id, userEmail: auth.user.email, requestId: request.headers.get("x-fila-dp-request-id") });
    return Response.json({ closed: true, ...result });
  } catch (error) { return apiError(error); }
}
