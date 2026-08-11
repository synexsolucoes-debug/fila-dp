import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const employee = await d1.prepare("SELECT company_id FROM fdp_employees WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<{ company_id: string }>();
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, employee.company_id);
    const result = await d1.prepare(`SELECT id, actor_email, action, before_json, after_json, metadata_json, created_at
      FROM fdp_audit_events WHERE workspace_id = ? AND entity_type = 'employee' AND entity_id = ?
      ORDER BY created_at DESC LIMIT 100`).bind(workspace.id, id).all();
    return Response.json({ events: result.results });
  } catch (error) { return apiError(error); }
}
