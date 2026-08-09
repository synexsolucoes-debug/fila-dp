import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { auxiliaryCapability, parseAuxiliaryModule, providerTypeForModule } from "@/lib/auxiliary";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const moduleType = parseAuxiliaryModule(url.searchParams.get("module"));
    requireCapability(workspace.role, auxiliaryCapability(moduleType, "read"));
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const requestedCompetence = url.searchParams.get("competence") ? validCompetence(url.searchParams.get("competence")) : "";
    const cycles = await d1.prepare(`SELECT id, company_id, competence, status, payment_date, closed_at
      FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? ORDER BY competence DESC LIMIT 36`)
      .bind(workspace.id, companyId).all<Record<string, unknown>>();
    const competence = requestedCompetence || String(cycles.results[0]?.competence ?? new Date().toISOString().slice(0, 7));
    const cycle = cycles.results.find((item) => item.competence === competence) ?? null;
    const cycleId = cycle ? String(cycle.id) : "";
    const [executions, providers, approvers] = await Promise.all([
      cycleId ? d1.prepare(`SELECT e.*, p.legal_name AS provider_legal_name, p.trade_name AS provider_trade_name,
          r.id AS revision_id, r.status AS revision_status, r.input_json, r.output_json,
          approval.id AS approval_id, approval.status AS approval_status, approval.approver_user_id,
          (approval.approver_user_id = ?) AS can_decide
        FROM fdp_auxiliary_executions e
        LEFT JOIN fdp_auxiliary_providers p ON p.workspace_id = e.workspace_id AND p.id = e.provider_id
        JOIN fdp_auxiliary_execution_revisions r ON r.workspace_id = e.workspace_id AND r.execution_id = e.id AND r.revision = e.current_revision
        LEFT JOIN fdp_auxiliary_approval_steps approval ON approval.workspace_id = e.workspace_id AND approval.revision_id = r.id AND approval.status = 'pending'
        WHERE e.workspace_id = ? AND e.company_id = ? AND e.payroll_cycle_id = ? AND e.module_type = ?
        ORDER BY CASE e.status WHEN 'pending_approval' THEN 0 WHEN 'rejected' THEN 1 WHEN 'draft' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END, e.due_date, e.created_at DESC`)
        .bind(user.id, workspace.id, companyId, cycleId, moduleType).all() : Promise.resolve({ results: [] }),
      d1.prepare(`SELECT id, provider_type, code, legal_name, trade_name, tax_id, email, phone, status
        FROM fdp_auxiliary_providers WHERE workspace_id = ? AND provider_type = ? ORDER BY status, legal_name`)
        .bind(workspace.id, providerTypeForModule(moduleType)).all(),
      d1.prepare(`SELECT u.id, u.name, u.email, wm.role FROM fdp_workspace_members wm JOIN fdp_users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND wm.role IN ('admin', 'member') AND (
          wm.role = 'admin' OR EXISTS (SELECT 1 FROM fdp_member_company_access access WHERE access.workspace_id = wm.workspace_id AND access.user_id = wm.user_id AND access.company_id = ?)
        ) ORDER BY u.name`).bind(workspace.id, companyId).all(),
    ]);
    return Response.json({
      module: moduleType, competence, cycle, cycles: cycles.results, executions: executions.results, providers: providers.results, approvers: approvers.results,
      permissions: {
        manage: hasCapability(workspace.role, auxiliaryCapability(moduleType, "manage")),
        requestApproval: hasCapability(workspace.role, "auxiliary.approvals.request"),
        decideApproval: hasCapability(workspace.role, "auxiliary.approvals.decide"),
        close: hasCapability(workspace.role, "auxiliary.close"),
      },
      privacyBoundary: moduleType === "psychology" ? "Somente dados administrativos agregados; dados clínicos são proibidos." : null,
    });
  } catch (error) { return apiError(error); }
}
