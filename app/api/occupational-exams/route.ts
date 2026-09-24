import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { occupationalExamFromRow, parseOccupationalExamInput } from "@/lib/occupational-exams";

/**
 * Um colaborador por vez: a tela de exames vive dentro da ficha dele
 * (`EmployeeExamsPanel`), no mesmo padrão de `/api/epi/employees/[id]`.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "exams.view", "consultar exames ocupacionais");
    const employeeId = cleanText(new URL(request.url).searchParams.get("employeeId"), 120);
    if (!employeeId) throw ApiError.badRequest("Selecione o colaborador.", "EXAM_EMPLOYEE_REQUIRED");
    const employee = await d1.prepare("SELECT company_id FROM fdp_employees WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, employeeId).first<{ company_id: string }>();
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EXAM_EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, employee.company_id);
    const result = await d1.prepare(`SELECT * FROM fdp_occupational_exams
      WHERE workspace_id = ? AND employee_id = ? ORDER BY exam_date DESC, created_at DESC`)
      .bind(workspace.id, employeeId).all<Record<string, unknown>>();
    return Response.json({ exams: result.results.map(occupationalExamFromRow) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "exams.manage", "registrar um exame ocupacional");
    const input = parseOccupationalExamInput(body);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);
    const employee = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND id = ?")
      .bind(workspace.id, input.companyId, input.employeeId).first();
    if (!employee) throw ApiError.badRequest("O colaborador não pertence à empresa selecionada.", "EXAM_EMPLOYEE_INVALID");

    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_occupational_exams
        (id, workspace_id, company_id, employee_id, exam_type, exam_date, result, restriction_notes,
         next_due_date, clinic_name, doctor_name, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, input.companyId, input.employeeId, input.examType, input.examDate, input.result,
          input.restrictionNotes, input.nextDueDate, input.clinicName, input.doctorName, input.notes, user.id, user.id),
      /* O resultado entra na trilha porque é o fato administrativo (apto/
         inapto), não o exame em si. Restrição funcional e notas ficam fora:
         são texto livre e a guarda clínica já as protege na escrita — não
         precisam de uma segunda cópia na auditoria. */
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "occupational_exam.created", entityType: "occupational_exam", entityId: id,
        after: { companyId: input.companyId, employeeId: input.employeeId, examType: input.examType, examDate: input.examDate, result: input.result, nextDueDate: input.nextDueDate },
        metadata: { scope: "company", companyId: input.companyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ exam: { id, ...input } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
