import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { parseTrainingInput } from "@/lib/trainings";

type RouteContext = { params: Promise<{ id: string }> };

type TrainingRow = {
  id: string; company_id: string; employee_id: string; training_name: string; completed_on: string;
  valid_until: string | null;
};

async function trainingOf(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"], workspaceId: string, id: string) {
  const training = await d1.prepare("SELECT * FROM fdp_trainings WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, id).first<TrainingRow>();
  if (!training) throw ApiError.notFound("Treinamento não encontrado.", "TRAINING_NOT_FOUND");
  return training;
}

/** O estado que vai para a trilha — o fato administrativo, não observações livres. */
const auditView = (row: TrainingRow) => ({
  companyId: row.company_id, employeeId: row.employee_id, trainingName: row.training_name,
  completedOn: String(row.completed_on).slice(0, 10),
  validUntil: row.valid_until ? String(row.valid_until).slice(0, 10) : null,
});

/**
 * Corrigir o treinamento.
 *
 * Mesma validação do cadastro e substitui o registro inteiro — o mesmo
 * raciocínio de `PATCH /api/occupational-exams/[id]`: lançado no colaborador
 * errado é o engano mais comum, e apagar/relançar tiraria o histórico de
 * quem já corrigiu a data.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "trainings.manage", "corrigir um treinamento obrigatório");
    const current = await trainingOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, current.company_id);
    const input = parseTrainingInput(body);
    if (input.companyId !== current.company_id) {
      await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);
    }
    const employee = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND id = ?")
      .bind(workspace.id, input.companyId, input.employeeId).first();
    if (!employee) throw ApiError.badRequest("O colaborador não pertence à empresa selecionada.", "TRAINING_EMPLOYEE_INVALID");

    await d1.batch([
      d1.prepare(`UPDATE fdp_trainings SET company_id = ?, employee_id = ?, training_name = ?, completed_on = ?,
          valid_until = ?, provider_name = ?, certificate_number = ?, notes = ?,
          updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(input.companyId, input.employeeId, input.trainingName, input.completedOn, input.validUntil,
          input.providerName, input.certificateNumber, input.notes, user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "training.updated", entityType: "training", entityId: id,
        before: auditView(current),
        after: { companyId: input.companyId, employeeId: input.employeeId, trainingName: input.trainingName, completedOn: input.completedOn, validUntil: input.validUntil },
        metadata: { scope: "company", companyId: input.companyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ training: { id, ...input } });
  } catch (error) { return apiError(error); }
}

/**
 * Excluir o treinamento.
 *
 * Permissão própria, e não a de registrar — o mesmo raciocínio de
 * `exams.delete`: apagar um treinamento apaga a prova de que a empresa
 * cumpriu a NR naquela data.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "trainings.delete", "excluir um treinamento obrigatório");
    const current = await trainingOf(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, current.company_id);

    await d1.batch([
      d1.prepare("DELETE FROM fdp_trainings WHERE workspace_id = ? AND id = ?").bind(workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "training.deleted", entityType: "training", entityId: id,
        before: auditView(current),
        metadata: { scope: "company", companyId: current.company_id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ deleted: id });
  } catch (error) { return apiError(error); }
}
