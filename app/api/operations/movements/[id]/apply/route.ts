import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { movementEmploymentEffect, movementTransferEffect } from "@/lib/operations";
import { terminatedFrom } from "@/lib/employee-history";
import { competenceOf, processedCycleStatuses, retroactivityKey, retroactivityTitle } from "@/lib/erp-dp";
import { blocksReturnToWork, type ExamResult } from "@/lib/occupational-exams";
import { prepareHistoryChange } from "@/lib/employee-history-service";

type Context = { params: Promise<{ id: string }> };

function detailsOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } }
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
}

/**
 * Motor de Jornadas, passo 1 (§4.16): aplicar é a única transição que escreve
 * no cadastro do colaborador, e escreve na mesma transação que marca a
 * movimentação como aplicada — mesmo desenho de
 * `app/api/registrations/contractors/[id]/movements/[movementId]/route.ts`,
 * a única "aplicação" que já existia no produto.
 *
 * Ação própria, e não parte do `PATCH` de movimentação (que só edita
 * rascunho) nem da decisão de aprovação (que só decide, não aplica): as três
 * coisas acontecem em momentos diferentes, e "aprovada" precisava parar de
 * ser um estado sem saída — `applied` já existia no vocabulário da coluna e
 * nenhuma rota levava até ele.
 *
 * Passo 2 (§4.17) estendeu o mesmo mecanismo para `transfer`: mesma empresa
 * move departamento/cargo/centro de custo; empresa diferente recusa com
 * motivo claro, em vez de mover parcialmente ou fingir sucesso.
 */
export async function POST(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "movements.manage");

    const movement = await d1.prepare(`SELECT m.company_id, m.employee_id, m.movement_type, m.status, m.details_json,
        m.effective_date, m.title, e.employment_status AS employee_status
      FROM fdp_employee_movements m
      JOIN fdp_employees e ON e.workspace_id = m.workspace_id AND e.id = m.employee_id
      WHERE m.workspace_id = ? AND m.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!movement) throw ApiError.notFound("Movimentação não encontrada.", "MOVEMENT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(movement.company_id));
    if (movement.status !== "approved") {
      throw ApiError.badRequest("Só uma movimentação aprovada pode ser aplicada.", "MOVEMENT_NOT_APPLIABLE");
    }

    const effect = movementEmploymentEffect(String(movement.movement_type));
    if (effect && movement.employee_status !== effect.requiredCurrentStatus) {
      throw new ApiError(409, "EMPLOYEE_STATUS_CONFLICT",
        "A situação do colaborador mudou desde a aprovação e não corresponde mais ao que esta movimentação espera.");
    }

    /* Retorno de afastamento (ERP DP, passo 2): a mesma trava da edição do
       cadastro (§4.9) — o último exame dizendo inapto impede a volta. Sem
       ela, a medida viraria o atalho para contornar o exame. */
    if (movement.movement_type === "return_to_work") {
      const latestExam = await d1.prepare(`SELECT result FROM fdp_occupational_exams
        WHERE workspace_id = ? AND employee_id = ? ORDER BY exam_date DESC, created_at DESC LIMIT 1`)
        .bind(workspace.id, movement.employee_id).first<{ result: string }>();
      if (latestExam && blocksReturnToWork(latestExam.result as ExamResult)) {
        throw ApiError.badRequest(
          "O último exame ocupacional registra este colaborador como inapto. Registre um novo exame de retorno antes de aplicar o retorno.",
          "EMPLOYEE_RETURN_BLOCKED_BY_EXAM",
        );
      }
    }

    const details = detailsOf(movement.details_json);
    const terminationDate = effect?.employmentStatus === "terminated" && typeof details.lastWorkingDate === "string" && details.lastWorkingDate
      ? details.lastWorkingDate : null;

    /* Transferência tem o próprio efeito (§4.17): recusa clara para empresa
       diferente ou destino ausente, em vez de aplicar parcialmente ou em
       silêncio. Recusar aqui, antes do batch, deixa a movimentação em
       "aprovada" — nunca "applied" para um efeito que não aconteceu. */
    let transfer: { departmentId: string | null; positionId: string | null; costCenterId: string | null } | null = null;
    if (movement.movement_type === "transfer") {
      const transferEffect = movementTransferEffect(details, String(movement.company_id));
      if (transferEffect.kind === "missing_target") {
        throw ApiError.badRequest("Informe a empresa de destino antes de aplicar a transferência.", "TRANSFER_TARGET_REQUIRED");
      }
      if (transferEffect.kind === "cross_company") {
        throw ApiError.badRequest(
          "Transferência para outra empresa ainda não é aplicada automaticamente. Atualize o cadastro do colaborador na empresa de destino manualmente.",
          "TRANSFER_CROSS_COMPANY_NOT_SUPPORTED",
        );
      }
      if (!transferEffect.departmentId && !transferEffect.positionId && !transferEffect.costCenterId) {
        throw ApiError.badRequest("Informe ao menos um destino — departamento, cargo ou centro de custo.", "TRANSFER_NO_TARGET");
      }
      transfer = transferEffect;
    }

    const statements = [
      d1.prepare("UPDATE fdp_employee_movements SET status = 'applied', updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND status = 'approved'")
        .bind(workspace.id, id),
    ];
    if (effect) {
      statements.push(
        terminationDate
          ? d1.prepare(`UPDATE fdp_employees SET employment_status = ?, termination_date = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
              WHERE workspace_id = ? AND id = ? AND employment_status = ?`)
            .bind(effect.employmentStatus, terminationDate, user.id, workspace.id, movement.employee_id, effect.requiredCurrentStatus)
          : d1.prepare(`UPDATE fdp_employees SET employment_status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
              WHERE workspace_id = ? AND id = ? AND employment_status = ?`)
            .bind(effect.employmentStatus, user.id, workspace.id, movement.employee_id, effect.requiredCurrentStatus),
      );
    }
    if (transfer) {
      statements.push(d1.prepare(`UPDATE fdp_employees SET
          department_id = COALESCE(?, department_id), position_id = COALESCE(?, position_id), cost_center_id = COALESCE(?, cost_center_id),
          updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ?`)
        .bind(transfer.departmentId, transfer.positionId, transfer.costCenterId, user.id, workspace.id, movement.employee_id));
    }
    /* Histórico funcional (§4.27): a mudança ganha data de validade no mesmo
       lote. Sem isto, aplicar uma transferência apagava o departamento
       anterior — o cadastro só sabe o agora. */
    const effectiveDate = String(movement.effective_date instanceof Date
      ? movement.effective_date.toISOString() : movement.effective_date).slice(0, 10);
    if (effect || transfer) {
      statements.push(...await prepareHistoryChange(d1, {
        workspaceId: workspace.id, employeeId: String(movement.employee_id), userId: user.id, movementId: id,
        reason: effect?.employmentStatus === "terminated" ? "termination"
          : effect?.employmentStatus === "active" ? "return_to_work" : effect ? "leave" : "transfer",
        effectiveDate: effect?.employmentStatus === "terminated" ? terminatedFrom(terminationDate ?? effectiveDate) : effectiveDate,
        changes: effect
          ? { situation: { employmentStatus: effect.employmentStatus } }
          : { assignment: {
              departmentId: transfer?.departmentId ?? undefined,
              positionId: transfer?.positionId ?? undefined,
              costCenterId: transfer?.costCenterId ?? undefined,
            } },
      }));
    }
    /* Retroatividade (ERP DP, passo 2 — o infotipo 0003 do SAP, sem
       recálculo): a movimentação vale a partir de um mês cuja folha já foi
       processada. O Vinculato não recalcula, mas não deixa a diferença cair
       no esquecimento: abre pendência para o DP lançar na próxima folha.
       Vale para todo tipo de movimentação — alteração salarial retroativa é
       o caso mais comum. Idempotente pela chave: reaplicar não duplica. */
    const retroCompetence = competenceOf(effectiveDate);
    const processedCycle = await d1.prepare(`SELECT id, status FROM fdp_payroll_cycles
      WHERE workspace_id = ? AND company_id = ? AND competence = ? AND status IN (${processedCycleStatuses.map(() => "?").join(", ")})`)
      .bind(workspace.id, movement.company_id, retroCompetence, ...processedCycleStatuses).first<{ id: string; status: string }>();
    if (processedCycle) {
      statements.push(d1.prepare(`INSERT INTO fdp_operational_pending_items
          (id, workspace_id, company_id, payroll_cycle_id, source_type, source_id, severity, blocking, title, status, idempotency_key)
        VALUES (?, ?, ?, NULL, 'movement', ?, 'warning', 0, ?, 'open', ?)
        ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`)
        .bind(crypto.randomUUID(), workspace.id, movement.company_id, id,
          retroactivityTitle(String(movement.title ?? ""), retroCompetence), retroactivityKey(id)));
    }
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "movement.applied", entityType: "employee_movement", entityId: id,
      before: { status: "approved" },
      after: { status: "applied", employmentStatus: effect?.employmentStatus ?? null, transfer },
      metadata: { movementType: String(movement.movement_type), employeeId: String(movement.employee_id) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    await d1.batch(statements);
    return Response.json({
      movement: { id, status: "applied" }, employmentStatus: effect?.employmentStatus ?? null, transfer,
      retroactive: processedCycle ? { competence: retroCompetence, cycleStatus: processedCycle.status } : null,
    });
  } catch (error) { return apiError(error); }
}
