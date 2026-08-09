import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, enumValue, optionalDate, protectCpf, publicEmployee } from "@/lib/registrations";

const employeeSelect = `SELECT e.id, e.company_id, c.legal_name AS company_name, e.department_id, d.name AS department_name,
  e.position_id, p.name AS position_name, e.cost_center_id, cc.name AS cost_center_name,
  e.work_schedule_id, ws.name AS work_schedule_name, e.manager_employee_id,
  e.registration_number, e.full_name, e.social_name, e.cpf_last4, e.email, e.phone, e.birth_date,
  e.admission_date, e.termination_date, e.employment_status, e.employment_type, e.work_model,
  e.source_system, e.external_id, e.notes, e.created_at, e.updated_at
  FROM fdp_employees e
  JOIN fdp_companies c ON c.id = e.company_id AND c.workspace_id = e.workspace_id
  LEFT JOIN fdp_departments d ON d.id = e.department_id AND d.workspace_id = e.workspace_id
  LEFT JOIN fdp_positions p ON p.id = e.position_id AND p.workspace_id = e.workspace_id
  LEFT JOIN fdp_cost_centers cc ON cc.id = e.cost_center_id AND cc.workspace_id = e.workspace_id
  LEFT JOIN fdp_work_schedules ws ON ws.id = e.work_schedule_id AND ws.workspace_id = e.workspace_id`;

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "employees.read");
    const url = new URL(request.url);
    const search = cleanText(url.searchParams.get("search"), 120);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const status = cleanText(url.searchParams.get("status"), 30);
    const cursor = cleanText(url.searchParams.get("cursor"), 120);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 1), 100);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ employees: [], nextCursor: null });
    const where = ["e.workspace_id = ?"];
    const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`e.company_id IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }
    if (companyId) { where.push("e.company_id = ?"); values.push(companyId); }
    if (["active", "on_leave", "terminated"].includes(status)) { where.push("e.employment_status = ?"); values.push(status); }
    if (search) { where.push("(e.full_name ILIKE ? OR e.social_name ILIKE ? OR e.registration_number ILIKE ?)"); values.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (cursor) { where.push("e.id > ?"); values.push(cursor); }
    const result = await d1.prepare(`${employeeSelect} WHERE ${where.join(" AND ")} ORDER BY e.id LIMIT ?`)
      .bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit).map(publicEmployee);
    return Response.json({ employees: rows, nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "employees.manage");
    const companyId = cleanText(body.companyId, 120);
    const fullName = cleanText(body.fullName, 160);
    const registrationNumber = cleanText(body.registrationNumber, 60);
    if (!companyId || !fullName || !registrationNumber) throw ApiError.badRequest("Empresa, nome e matrícula são obrigatórios.", "EMPLOYEE_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const duplicate = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND registration_number = ?")
      .bind(workspace.id, companyId, registrationNumber).first();
    if (duplicate) throw new ApiError(409, "EMPLOYEE_REGISTRATION_CONFLICT", "Já existe um colaborador com esta matrícula na empresa.");
    const cpf = protectCpf(body.cpf);
    if (cpf.cpfHash) {
      const cpfDuplicate = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND cpf_hash = ?").bind(workspace.id, cpf.cpfHash).first();
      if (cpfDuplicate) throw new ApiError(409, "EMPLOYEE_CPF_CONFLICT", "Já existe um colaborador com este CPF no grupo.");
    }
    const row = {
      id: crypto.randomUUID(), companyId, departmentId: cleanText(body.departmentId, 120) || null,
      positionId: cleanText(body.positionId, 120) || null, costCenterId: cleanText(body.costCenterId, 120) || null,
      workScheduleId: cleanText(body.workScheduleId, 120) || null, managerEmployeeId: cleanText(body.managerEmployeeId, 120) || null,
      registrationNumber, fullName, socialName: cleanText(body.socialName, 160), cpfLast4: cpf.cpfLast4,
      email: cleanText(body.email, 160), phone: cleanText(body.phone, 40), birthDate: optionalDate(body.birthDate),
      admissionDate: optionalDate(body.admissionDate, true), terminationDate: optionalDate(body.terminationDate),
      employmentStatus: enumValue(body.employmentStatus, ["active", "on_leave", "terminated"] as const, "active"),
      employmentType: enumValue(body.employmentType, ["clt", "intern", "apprentice", "temporary"] as const, "clt"),
      workModel: enumValue(body.workModel, ["onsite", "hybrid", "remote"] as const, "onsite"),
      notes: cleanText(body.notes, 2000),
    };
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_employees (id, workspace_id, company_id, department_id, position_id, cost_center_id, work_schedule_id,
        manager_employee_id, registration_number, full_name, social_name, cpf_hash, cpf_last4, email, phone, birth_date, admission_date,
        termination_date, employment_status, employment_type, work_model, source_system, external_id, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', '', ?, ?, ?)`)
        .bind(row.id, workspace.id, row.companyId, row.departmentId, row.positionId, row.costCenterId, row.workScheduleId,
          row.managerEmployeeId, row.registrationNumber, row.fullName, row.socialName, cpf.cpfHash, row.cpfLast4, row.email, row.phone,
          row.birthDate, row.admissionDate, row.terminationDate, row.employmentStatus, row.employmentType, row.workModel, row.notes, user.id, user.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "employee.created",
        entityType: "employee", entityId: row.id, after: { ...row, cpfLast4: row.cpfLast4 ? `***${row.cpfLast4}` : "" },
        metadata: { sourceSystem: "manual" }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    const created = await d1.prepare(`${employeeSelect} WHERE e.workspace_id = ? AND e.id = ?`).bind(workspace.id, row.id).first<Record<string, unknown>>();
    return Response.json({ employee: created ? publicEmployee(created) : { ...row, source_system: "manual" } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
