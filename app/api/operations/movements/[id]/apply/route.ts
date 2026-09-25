import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { movementEmploymentEffect } from "@/lib/operations";

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
 */
export async function POST(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "movements.manage");

    const movement = await d1.prepare(`SELECT m.company_id, m.employee_id, m.movement_type, m.status, m.details_json,
        e.employment_status AS employee_status
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

    const details = detailsOf(movement.details_json);
    const terminationDate = effect?.employmentStatus === "terminated" && typeof details.lastWorkingDate === "string" && details.lastWorkingDate
      ? details.lastWorkingDate : null;

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
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "movement.applied", entityType: "employee_movement", entityId: id,
      before: { status: "approved" }, after: { status: "applied", employmentStatus: effect?.employmentStatus ?? null },
      metadata: { movementType: String(movement.movement_type), employeeId: String(movement.employee_id) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    await d1.batch(statements);
    return Response.json({ movement: { id, status: "applied" }, employmentStatus: effect?.employmentStatus ?? null });
  } catch (error) { return apiError(error); }
}
