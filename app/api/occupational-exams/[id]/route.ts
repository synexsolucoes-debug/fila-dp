import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { parseOccupationalExamInput } from "@/lib/occupational-exams";

type RouteContext = { params: Promise<{ id: string }> };

type ExamRow = {
  id: string; company_id: string; employee_id: string; exam_type: string; exam_date: string;
  result: string; next_due_date: string | null;
};

async function examOf(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"], workspaceId: string, id: string) {
  const exam = await d1.prepare("SELECT * FROM fdp_occupational_exams WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, id).first<ExamRow>();
  if (!exam) throw ApiError.notFound("Exame não encontrado.", "EXAM_NOT_FOUND");
  return exam;
}

/** O estado que vai para a trilha — o fato administrativo, não a restrição funcional em texto livre. */
const auditView = (row: ExamRow) => ({
  companyId: row.company_id, employeeId: row.employee_id, examType: row.exam_type,
  examDate: String(row.exam_date).slice(0, 10), result: row.result,
  nextDueDate: row.next_due_date ? String(row.next_due_date).slice(0, 10) : null,
});

/**
 * Corrigir o exame.
 *
 * Mesma validação do cadastro, e substitui o registro inteiro — o mesmo
 * raciocínio de `PATCH /api/safety/accidents/[id]`: exame lançado no
 * colaborador errado é o engano mais comum, e obrigar a apagar e relançar
 * tiraria o histórico de quem já tinha corrigido a data.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "exams.manage", "corrigir um exame ocupacional");
    const current = await examOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, current.company_id);
    const input = parseOccupationalExamInput(body);
    if (input.companyId !== current.company_id) {
      await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);
    }
    const employee = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND id = ?")
      .bind(workspace.id, input.companyId, input.employeeId).first();
    if (!employee) throw ApiError.badRequest("O colaborador não pertence à empresa selecionada.", "EXAM_EMPLOYEE_INVALID");

    await d1.batch([
      d1.prepare(`UPDATE fdp_occupational_exams SET company_id = ?, employee_id = ?, exam_type = ?, exam_date = ?,
          result = ?, restriction_notes = ?, next_due_date = ?, clinic_name = ?, doctor_name = ?, notes = ?,
          updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(input.companyId, input.employeeId, input.examType, input.examDate, input.result, input.restrictionNotes,
          input.nextDueDate, input.clinicName, input.doctorName, input.notes, user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "occupational_exam.updated", entityType: "occupational_exam", entityId: id,
        before: auditView(current),
        after: { companyId: input.companyId, employeeId: input.employeeId, examType: input.examType, examDate: input.examDate, result: input.result, nextDueDate: input.nextDueDate },
        metadata: { scope: "company", companyId: input.companyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ exam: { id, ...input } });
  } catch (error) { return apiError(error); }
}

/**
 * Excluir o exame.
 *
 * Permissão própria, e não a de registrar — o mesmo raciocínio de
 * `safety.delete`: apagar um exame apaga a prova de que a empresa cumpriu a
 * NR-7 naquela data. O caminho normal para um lançamento errado é
 * corrigi-lo; excluir serve para o duplicado e para o que nunca aconteceu.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "exams.delete", "excluir um exame ocupacional");
    const current = await examOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, current.company_id);

    await d1.batch([
      d1.prepare("DELETE FROM fdp_occupational_exams WHERE workspace_id = ? AND id = ?").bind(workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "occupational_exam.deleted", entityType: "occupational_exam", entityId: id,
        before: auditView(current),
        metadata: { scope: "company", companyId: current.company_id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ deleted: id });
  } catch (error) { return apiError(error); }
}
