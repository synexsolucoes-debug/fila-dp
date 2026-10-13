import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { companyScopeClause } from "@/lib/erp-dp-service";
import { calculateRun, cycleFor, runFor, runResults } from "@/lib/payroll-run-service";

/**
 * Folha da competência do ERP DP (§4.32 de docs/arquitetura-operacional.md).
 *
 * GET sem `cycleId`: as competências do escopo com o estado da folha de cada
 * uma. Com `cycleId`: a folha e o resultado de cada colaborador.
 * POST: calcula ou recalcula a folha da competência da empresa inteira.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const url = new URL(request.url);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    const cycleId = url.searchParams.get("cycleId") ?? "";
    if (cycleId) {
      const cycle = await d1.prepare(`SELECT c.id, c.company_id, c.competence, c.status, c.payment_date,
          COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name
        FROM fdp_payroll_cycles c JOIN fdp_companies co ON co.workspace_id = c.workspace_id AND co.id = c.company_id
        WHERE c.workspace_id = ? AND c.id = ?`).bind(workspace.id, cycleId).first<Record<string, unknown>>();
      if (!cycle) throw ApiError.notFound("Competência não encontrada.", "PAYROLL_CYCLE_NOT_FOUND");
      await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(cycle.company_id));
      const run = await runFor(d1, workspace.id, cycleId);
      return Response.json({ cycle, run, results: run ? await runResults(d1, workspace.id, run.id) : [] });
    }
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, url.searchParams.get("companyId") ?? "", "c.company_id");
    if (!scope) return Response.json({ cycles: [] });
    const rows = await d1.prepare(`SELECT c.id, c.company_id, c.competence, c.status, c.payment_date,
        COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name,
        r.id AS run_id, r.status AS run_status, r.employees_count, r.net_cents, r.calculated_at
      FROM fdp_payroll_cycles c JOIN fdp_companies co ON co.workspace_id = c.workspace_id AND co.id = c.company_id
      LEFT JOIN fdp_payroll_runs r ON r.workspace_id = c.workspace_id AND r.payroll_cycle_id = c.id
      WHERE c.workspace_id = ? AND ${scope.clause}
      ORDER BY c.competence DESC, company_name LIMIT 36`).bind(workspace.id, ...scope.values).all<Record<string, unknown>>();
    return Response.json({ cycles: rows.results ?? [] });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const companyId = String(body.companyId ?? "");
    const competence = String(body.competence ?? "");
    if (!companyId) throw ApiError.badRequest("Escolha a empresa.", "PAYROLL_COMPANY_REQUIRED");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(competence)) throw ApiError.badRequest("Informe a competência.", "PAYROLL_COMPETENCE_REQUIRED");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.manage");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const runId = await calculateRun(d1, {
      workspaceId: workspace.id, companyId, competence, userId: user.id, userEmail: auth.user.email,
      requestId: request.headers.get("x-fila-dp-request-id"),
    });
    const cycle = await cycleFor(d1, workspace.id, companyId, competence);
    return Response.json({ run: await runFor(d1, workspace.id, cycle.id), results: await runResults(d1, workspace.id, runId) });
  } catch (error) { return apiError(error); }
}
