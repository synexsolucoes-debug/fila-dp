import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { blocksReturnToWork, type ExamResult } from "@/lib/occupational-exams";
import { prepareHistoryChange } from "@/lib/employee-history-service";
import { prepareRetroactiveItem } from "@/lib/erp-dp-service";

/**
 * ERP DP — medida "Retorno de afastamento" (PA40 do SAP).
 *
 * Executada no próprio ERP, como medida: grava a situação "ativo" com a data
 * do retorno no histórico funcional, devolve o cadastro a ativo e, se a data
 * cai numa competência já processada, abre o retroativo — tudo no mesmo lote.
 * Não cria movimentação na Operação DP: o que é ERP fica no ERP (§4.30).
 *
 * A mesma trava da edição do cadastro (§4.9): o último exame dizendo inapto
 * impede a volta.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "movements.manage");
    const employeeId = cleanText(body.employeeId, 120);
    const returnDate = optionalDate(body.returnDate, true) as string;
    const notes = cleanText(body.notes, 500);
    if (!employeeId) throw ApiError.badRequest("Selecione o colaborador.", "ERP_EMPLOYEE_REQUIRED");

    const employee = await d1.prepare(`SELECT id, company_id, full_name, social_name, employment_status, admission_date
      FROM fdp_employees WHERE workspace_id = ? AND id = ?`).bind(workspace.id, employeeId).first<Record<string, unknown>>();
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(employee.company_id));
    if (employee.employment_status !== "on_leave") {
      throw new ApiError(409, "EMPLOYEE_NOT_ON_LEAVE", "Só um colaborador afastado pode ter o retorno registrado.");
    }
    const admission = String(employee.admission_date instanceof Date ? employee.admission_date.toISOString() : employee.admission_date).slice(0, 10);
    if (returnDate <= admission) throw ApiError.badRequest("O retorno precisa ser depois da admissão.", "ERP_RETURN_BEFORE_ADMISSION");

    const latestExam = await d1.prepare(`SELECT result FROM fdp_occupational_exams
      WHERE workspace_id = ? AND employee_id = ? ORDER BY exam_date DESC, created_at DESC LIMIT 1`)
      .bind(workspace.id, employeeId).first<{ result: string }>();
    if (latestExam && blocksReturnToWork(latestExam.result as ExamResult)) {
      throw ApiError.badRequest(
        "O último exame ocupacional registra este colaborador como inapto. Registre um novo exame de retorno antes de registrar o retorno.",
        "EMPLOYEE_RETURN_BLOCKED_BY_EXAM",
      );
    }

    const actionId = crypto.randomUUID();
    const name = String(employee.social_name || employee.full_name);
    const statements = [
      ...await prepareHistoryChange(d1, {
        workspaceId: workspace.id, employeeId, userId: user.id, reason: "return_to_work",
        effectiveDate: returnDate, changes: { situation: { employmentStatus: "active" } },
      }),
      d1.prepare(`UPDATE fdp_employees SET employment_status = 'active', updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ? AND employment_status = 'on_leave'`).bind(user.id, workspace.id, employeeId),
    ];
    const retro = await prepareRetroactiveItem(d1, {
      workspaceId: workspace.id, companyId: String(employee.company_id), employeeId,
      sourceType: "erp_action", sourceId: actionId, effectiveDate: returnDate, title: `Retorno de afastamento — ${name}`,
    });
    if (retro) statements.push(retro.statement);
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "erp.action.return_to_work", entityType: "employee", entityId: employeeId,
      before: { employmentStatus: "on_leave" }, after: { employmentStatus: "active", returnDate },
      metadata: { scope: "company", companyId: String(employee.company_id), actionId, notes },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));
    await d1.batch(statements);
    return Response.json({
      employeeId, employmentStatus: "active", returnDate,
      retroactive: retro ? { competence: retro.competence, cycleStatus: retro.cycleStatus } : null,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
