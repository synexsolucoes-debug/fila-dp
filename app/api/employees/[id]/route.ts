import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, enumValue, optionalDate, protectCpf, publicEmployee } from "@/lib/registrations";

type RouteContext = { params: Promise<{ id: string }> };

async function getEmployee(d1: D1Database, workspaceId: string, id: string) {
  return d1.prepare(`SELECT e.*, c.legal_name AS company_name, d.name AS department_name, p.name AS position_name,
    cc.name AS cost_center_name, ws.name AS work_schedule_name
    FROM fdp_employees e JOIN fdp_companies c ON c.id = e.company_id AND c.workspace_id = e.workspace_id
    LEFT JOIN fdp_departments d ON d.id = e.department_id AND d.workspace_id = e.workspace_id
    LEFT JOIN fdp_positions p ON p.id = e.position_id AND p.workspace_id = e.workspace_id
    LEFT JOIN fdp_cost_centers cc ON cc.id = e.cost_center_id AND cc.workspace_id = e.workspace_id
    LEFT JOIN fdp_work_schedules ws ON ws.id = e.work_schedule_id AND ws.workspace_id = e.workspace_id
    WHERE e.workspace_id = ? AND e.id = ?`).bind(workspaceId, id).first<Record<string, unknown>>();
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const employee = await getEmployee(d1, workspace.id, id);
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(employee.company_id));
    return Response.json({ employee: publicEmployee(employee) });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.manage");
    const current = await getEmployee(d1, workspace.id, id);
    if (!current) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    const companyId = cleanText(body.companyId, 120) || String(current.company_id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const registrationNumber = cleanText(body.registrationNumber, 60) || String(current.registration_number);
    const fullName = cleanText(body.fullName, 160) || String(current.full_name);
    const duplicate = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND registration_number = ? AND id <> ?")
      .bind(workspace.id, companyId, registrationNumber, id).first();
    if (duplicate) throw new ApiError(409, "EMPLOYEE_REGISTRATION_CONFLICT", "Já existe um colaborador com esta matrícula na empresa.");
    const hasCpf = Object.hasOwn(body, "cpf");
    const cpf = hasCpf ? protectCpf(body.cpf) : { cpfHash: String(current.cpf_hash), cpfLast4: String(current.cpf_last4) };
    if (hasCpf && cpf.cpfHash) {
      const cpfDuplicate = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND cpf_hash = ? AND id <> ?").bind(workspace.id, cpf.cpfHash, id).first();
      if (cpfDuplicate) throw new ApiError(409, "EMPLOYEE_CPF_CONFLICT", "Já existe um colaborador com este CPF no grupo.");
    }
    const pick = (key: string, column: string, max = 120) => Object.hasOwn(body, key) ? (cleanText(body[key], max) || null) : (current[column] ?? null);
    const next = {
      companyId, registrationNumber, fullName,
      departmentId: pick("departmentId", "department_id"), positionId: pick("positionId", "position_id"),
      costCenterId: pick("costCenterId", "cost_center_id"), workScheduleId: pick("workScheduleId", "work_schedule_id"),
      managerEmployeeId: pick("managerEmployeeId", "manager_employee_id"),
      socialName: Object.hasOwn(body, "socialName") ? cleanText(body.socialName, 160) : String(current.social_name),
      email: Object.hasOwn(body, "email") ? cleanText(body.email, 160) : String(current.email),
      phone: Object.hasOwn(body, "phone") ? cleanText(body.phone, 40) : String(current.phone),
      birthDate: Object.hasOwn(body, "birthDate") ? optionalDate(body.birthDate) : current.birth_date,
      admissionDate: Object.hasOwn(body, "admissionDate") ? optionalDate(body.admissionDate, true) : String(current.admission_date),
      terminationDate: Object.hasOwn(body, "terminationDate") ? optionalDate(body.terminationDate) : current.termination_date,
      employmentStatus: enumValue(body.employmentStatus, ["active", "on_leave", "terminated"] as const, current.employment_status as "active" | "on_leave" | "terminated"),
      employmentType: enumValue(body.employmentType, ["clt", "intern", "apprentice", "temporary"] as const, current.employment_type as "clt" | "intern" | "apprentice" | "temporary"),
      workModel: enumValue(body.workModel, ["onsite", "hybrid", "remote"] as const, current.work_model as "onsite" | "hybrid" | "remote"),
      notes: Object.hasOwn(body, "notes") ? cleanText(body.notes, 2000) : String(current.notes),
    };
    await d1.batch([
      d1.prepare(`UPDATE fdp_employees SET company_id = ?, department_id = ?, position_id = ?, cost_center_id = ?, work_schedule_id = ?,
        manager_employee_id = ?, registration_number = ?, full_name = ?, social_name = ?, cpf_hash = ?, cpf_last4 = ?, email = ?, phone = ?,
        birth_date = ?, admission_date = ?, termination_date = ?, employment_status = ?, employment_type = ?, work_model = ?, notes = ?,
        updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(next.companyId, next.departmentId, next.positionId, next.costCenterId, next.workScheduleId, next.managerEmployeeId,
          next.registrationNumber, next.fullName, next.socialName, cpf.cpfHash, cpf.cpfLast4, next.email, next.phone, next.birthDate,
          next.admissionDate, next.terminationDate, next.employmentStatus, next.employmentType, next.workModel, next.notes, user.id, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "employee.updated",
        entityType: "employee", entityId: id, before: publicEmployee(current), after: { ...next, cpfLast4: cpf.cpfLast4 ? `***${cpf.cpfLast4}` : "" },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    const updated = await getEmployee(d1, workspace.id, id);
    return Response.json({ employee: updated ? publicEmployee(updated) : null });
  } catch (error) { return apiError(error); }
}
