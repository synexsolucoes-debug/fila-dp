import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, getCatalogResource } from "@/lib/registrations";

type Context = { params: Promise<{ resource: string }> };

export async function GET(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { resource: key } = await context.params;
    const resource = getCatalogResource(key);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "employees.read");
    const companyId = cleanText(new URL(request.url).searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const extra = key === "positions" ? ", cbo_code" : key === "work-schedules" ? ", weekly_hours, description" : key === "departments" ? ", parent_department_id" : "";
    const result = await d1.prepare(`SELECT id, company_id, code, name, status${extra}, created_at, updated_at FROM ${resource.table} WHERE workspace_id = ? AND company_id = ? ORDER BY status, name`)
      .bind(workspace.id, companyId).all();
    return Response.json({ items: result.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { resource: key } = await context.params;
    const resource = getCatalogResource(key);
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "registrations.catalogs.manage");
    const companyId = cleanText(body.companyId, 120);
    const code = cleanText(body.code, 50);
    const name = cleanText(body.name, 160);
    if (!companyId || !code || !name) throw ApiError.badRequest("Empresa, código e nome são obrigatórios.", "CATALOG_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const duplicate = await d1.prepare(`SELECT id FROM ${resource.table} WHERE workspace_id = ? AND company_id = ? AND code = ?`).bind(workspace.id, companyId, code).first();
    if (duplicate) throw new ApiError(409, "CATALOG_CODE_CONFLICT", `Já existe ${resource.label.toLowerCase()} com este código.`);
    const id = crypto.randomUUID();
    const status = body.status === "inactive" ? "inactive" : "active";
    let insert: D1PreparedStatement;
    if (key === "positions") {
      insert = d1.prepare(`INSERT INTO ${resource.table} (id, workspace_id, company_id, code, name, cbo_code, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, companyId, code, name, cleanText(body.cboCode, 20), status);
    } else if (key === "work-schedules") {
      const weeklyHours = Math.min(Math.max(Number(body.weeklyHours) || 44, 1), 60);
      insert = d1.prepare(`INSERT INTO ${resource.table} (id, workspace_id, company_id, code, name, weekly_hours, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, companyId, code, name, weeklyHours, cleanText(body.description, 500), status);
    } else if (key === "departments") {
      insert = d1.prepare(`INSERT INTO ${resource.table} (id, workspace_id, company_id, parent_department_id, code, name, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, companyId, cleanText(body.parentDepartmentId, 120) || null, code, name, status);
    } else {
      insert = d1.prepare(`INSERT INTO ${resource.table} (id, workspace_id, company_id, code, name, status) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, companyId, code, name, status);
    }
    const after = { id, companyId, code, name, status };
    await d1.batch([insert, prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `registration.${key}.created`, entityType: `registration_${key}`, entityId: id, after,
      requestId: request.headers.get("x-fila-dp-request-id") })]);
    return Response.json({ item: after }, { status: 201 });
  } catch (error) { return apiError(error); }
}
