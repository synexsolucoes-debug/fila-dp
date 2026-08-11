import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "competences.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const requestedCompetence = url.searchParams.get("competence") ? validCompetence(url.searchParams.get("competence")) : "";
    const cyclesResult = await d1.prepare(`SELECT id, company_id, competence, status, pre_closing_due_date, payment_date, post_closing_due_date, closed_at, notes, created_at, updated_at
      FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? ORDER BY competence DESC LIMIT 36`).bind(workspace.id, companyId).all<Record<string, unknown>>();
    const competence = requestedCompetence || String(cyclesResult.results[0]?.competence ?? new Date().toISOString().slice(0, 7));
    const cycle = cyclesResult.results.find((item) => item.competence === competence) ?? null;
    const cycleId = cycle ? String(cycle.id) : "";
    const [demands, obligations, closingItems, pendingItems, processes, approvers] = await Promise.all([
      d1.prepare(`SELECT id, title, process_type, priority, due_at, legal_due_at, sla_status, archived, list_id
        FROM fdp_cards WHERE workspace_id = ? AND company_id = ? AND competence = ? ORDER BY COALESCE(legal_due_at, due_at), updated_at DESC LIMIT 80`).bind(workspace.id, companyId, competence).all(),
      cycleId ? d1.prepare(`SELECT id, obligation_type, title, due_date, status, owner_user_id, card_id, notes
        FROM fdp_compliance_obligations WHERE workspace_id = ? AND company_id = ? AND payroll_cycle_id = ? ORDER BY due_date, title`).bind(workspace.id, companyId, cycleId).all() : Promise.resolve({ results: [] }),
      cycleId ? d1.prepare(`SELECT id, phase, category, title, status, owner_user_id, due_date, completed_at, notes, position
        FROM fdp_payroll_cycle_items WHERE workspace_id = ? AND company_id = ? AND payroll_cycle_id = ? ORDER BY phase, position, title`).bind(workspace.id, companyId, cycleId).all() : Promise.resolve({ results: [] }),
      cycleId ? d1.prepare(`SELECT id, source_type, source_id, severity, blocking, title, due_date, status, owner_user_id, resolution
        FROM fdp_operational_pending_items WHERE workspace_id = ? AND company_id = ? AND payroll_cycle_id = ? ORDER BY blocking DESC, due_date, created_at`).bind(workspace.id, companyId, cycleId).all() : Promise.resolve({ results: [] }),
      d1.prepare(`SELECT d.id, d.code, d.name, d.category, d.status,
        COALESCE(MAX(v.version), 0) AS latest_version,
        COALESCE(MAX(v.version) FILTER (WHERE v.status = 'published'), 0) AS published_version
        FROM fdp_process_definitions d LEFT JOIN fdp_process_versions v ON v.workspace_id = d.workspace_id AND v.definition_id = d.id
        WHERE d.workspace_id = ? GROUP BY d.id ORDER BY d.status, d.name`).bind(workspace.id).all(),
      d1.prepare(`SELECT u.id, u.name, u.email, wm.role FROM fdp_workspace_members wm JOIN fdp_users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND wm.role IN ('admin', 'member') AND (
          wm.role = 'admin' OR EXISTS (SELECT 1 FROM fdp_member_company_access mca WHERE mca.workspace_id = wm.workspace_id AND mca.user_id = wm.user_id AND mca.company_id = ?)
        ) ORDER BY u.name`).bind(workspace.id, companyId).all(),
    ]);
    let movements: unknown[] = [];
    let approvals: unknown[] = [];
    if (hasCapability(workspace, "movements.read") && cycleId) {
      const [movementRows, approvalRows] = await Promise.all([
        d1.prepare(`SELECT m.id, m.employee_id, e.full_name AS employee_name, e.social_name, m.movement_type, m.effective_date, m.title, m.status, m.created_at, m.updated_at
          FROM fdp_employee_movements m JOIN fdp_employees e ON e.workspace_id = m.workspace_id AND e.id = m.employee_id
          WHERE m.workspace_id = ? AND m.company_id = ? AND m.payroll_cycle_id = ? ORDER BY m.effective_date, m.created_at DESC LIMIT 100`).bind(workspace.id, companyId, cycleId).all(),
        d1.prepare(`SELECT a.id, a.movement_id, a.sequence, a.approver_user_id, a.status, a.decided_at, a.comment,
          (a.approver_user_id = ?) AS can_decide,
          m.title AS movement_title, e.full_name AS employee_name
          FROM fdp_movement_approval_steps a JOIN fdp_employee_movements m ON m.workspace_id = a.workspace_id AND m.id = a.movement_id
          JOIN fdp_employees e ON e.workspace_id = m.workspace_id AND e.id = m.employee_id
          WHERE a.workspace_id = ? AND m.company_id = ? AND m.payroll_cycle_id = ? ORDER BY a.status, m.created_at DESC`).bind(user.id, workspace.id, companyId, cycleId).all(),
      ]);
      movements = movementRows.results;
      approvals = approvalRows.results;
    }
    return Response.json({
      competence, cycle, cycles: cyclesResult.results, demands: demands.results, obligations: obligations.results,
      closingItems: closingItems.results, pendingItems: pendingItems.results, processes: processes.results, movements, approvals,
      approvers: approvers.results,
      permissions: {
        manageCompetences: hasCapability(workspace, "competences.manage"), transitionCompetences: hasCapability(workspace, "competences.transition"),
        manageMovements: hasCapability(workspace, "movements.manage"), decideApprovals: hasCapability(workspace, "approvals.decide"),
        manageObligations: hasCapability(workspace, "obligations.manage"), managePending: hasCapability(workspace, "pending_items.manage"),
        manageProcesses: hasCapability(workspace, "processes.manage"), publishProcesses: hasCapability(workspace, "processes.publish"),
      },
    });
  } catch (error) { return apiError(error); }
}
