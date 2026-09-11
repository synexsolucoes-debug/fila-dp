import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { parseWorkAccidentInput } from "@/lib/work-accidents-service";

type RouteContext = { params: Promise<{ id: string }> };

type AccidentRow = {
  id: string; company_id: string; occurred_on: string; accident_type: string; body_part: string;
  sector: string; work_shift: string; gender: string; leave_days: number;
  expense_amount: string | number; cat_issued: number; cat_number: string;
};

async function accidentOf(
  d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"],
  workspaceId: string,
  id: string,
) {
  const accident = await d1.prepare("SELECT * FROM fdp_work_accidents WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, id).first<AccidentRow>();
  if (!accident) throw ApiError.notFound("Acidente não encontrado.", "SAFETY_ACCIDENT_NOT_FOUND");
  return accident;
}

/** O estado que vai para a trilha — sem nome de pessoa e sem relato do caso. */
const auditView = (row: AccidentRow) => ({
  companyId: row.company_id, occurredOn: String(row.occurred_on).slice(0, 10),
  accidentType: row.accident_type, bodyPart: row.body_part, sector: row.sector,
  workShift: row.work_shift, leaveDays: Number(row.leave_days) || 0,
  expenseAmount: Number(row.expense_amount) || 0, catIssued: Number(row.cat_issued) === 1,
});

/**
 * Corrigir o lançamento.
 *
 * A correção passa pela mesma validação do cadastro e substitui o registro
 * inteiro, inclusive a empresa: acidente lançado na filial errada é o engano
 * mais comum de quem opera duas, e obrigar a apagar e relançar tiraria o
 * histórico de quem já tinha corrigido a data.
 *
 * A permissão da empresa é conferida **duas vezes** — na de origem e na de
 * destino. Sem a primeira, quem só enxerga a filial B moveria para si um
 * acidente da filial A que nem deveria estar vendo.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "safety.manage", "corrigir um acidente de trabalho");
    const current = await accidentOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, current.company_id);
    const input = parseWorkAccidentInput(body);
    if (input.companyId !== current.company_id) {
      await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);
    }

    await d1.batch([
      d1.prepare(`UPDATE fdp_work_accidents SET company_id = ?, occurred_on = ?, accident_type = ?, body_part = ?,
          sector = ?, work_shift = ?, gender = ?, employee_label = ?, leave_days = ?, expense_amount = ?,
          cat_issued = ?, cat_number = ?, description = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(input.companyId, input.occurredOn, input.accidentType, input.bodyPart, input.sector,
          input.workShift, input.gender, input.employeeLabel, input.leaveDays, input.expenseAmount,
          input.catIssued ? 1 : 0, input.catNumber, input.description, user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "work_accident.updated", entityType: "work_accident", entityId: id,
        before: auditView(current),
        after: {
          companyId: input.companyId, occurredOn: input.occurredOn, accidentType: input.accidentType,
          bodyPart: input.bodyPart, sector: input.sector, workShift: input.workShift,
          leaveDays: input.leaveDays, expenseAmount: input.expenseAmount, catIssued: input.catIssued,
        },
        metadata: { scope: "company", companyId: input.companyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ accident: { id, ...input } });
  } catch (error) { return apiError(error); }
}

/**
 * Excluir o lançamento.
 *
 * Permissão própria, e não a de registrar: apagar um acidente apaga o número
 * que sustenta a análise do período inteiro, e a CAT que ele acompanha já saiu
 * da empresa. O caminho normal para um lançamento errado é corrigi-lo; excluir
 * serve para o duplicado e para o que nunca aconteceu.
 *
 * O que foi apagado fica na trilha, com o estado anterior inteiro. Sem isso, a
 * diferença entre o relatório de ontem e o de hoje não teria explicação.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "safety.delete", "excluir um acidente de trabalho");
    const current = await accidentOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, current.company_id);

    await d1.batch([
      d1.prepare("DELETE FROM fdp_work_accidents WHERE workspace_id = ? AND id = ?").bind(workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "work_accident.deleted", entityType: "work_accident", entityId: id,
        before: auditView(current),
        metadata: { scope: "company", companyId: current.company_id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ deleted: id });
  } catch (error) { return apiError(error); }
}
