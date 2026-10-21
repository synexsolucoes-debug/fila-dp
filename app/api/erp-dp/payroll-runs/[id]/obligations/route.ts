import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { obligationsSummary } from "@/lib/payroll-obligations";
import { runForObligations } from "@/lib/payroll-exports-service";

type RouteContext = { params: Promise<{ id: string }> };

/** Encargos e guias da folha com vencimento (§4.40): salários, FGTS Digital e DCTFWeb. */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    const { run, results, settings } = await runForObligations(d1, workspace, user.id, id);
    const missingBank = (await d1.prepare(`SELECT COUNT(*) AS total FROM fdp_payroll_results r
        LEFT JOIN fdp_employee_bank_accounts b ON b.workspace_id = r.workspace_id AND b.employee_id = r.employee_id
        WHERE r.workspace_id = ? AND r.run_id = ? AND b.id IS NULL`).bind(workspace.id, run.id).first<{ total: number }>())?.total ?? 0;
    return Response.json({ run, settings, summary: obligationsSummary(run.competence, results, settings), missingBank: Number(missingBank) });
  } catch (error) { return apiError(error); }
}
