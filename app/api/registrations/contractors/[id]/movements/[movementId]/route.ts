import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { centsFromDatabase, fromCents } from "@/lib/payments";
import { contractorBalance, requireContractorProfile } from "@/lib/payment-service";
import {
  assertContractCoherent, assertContractValueNotBelowConsumed, assertMovementTransition,
  type ContractType, type MovementStatus,
} from "@/lib/contractor-registry";
import { cleanText } from "@/lib/registrations";

type Params = { params: Promise<{ id: string; movementId: string }> };

const ALLOWED: readonly MovementStatus[] = ["pending_approval", "approved", "rejected", "applied", "canceled"];

type MovementRow = {
  id: string; movement_type: string; effective_date: string; status: string;
  after_json: Record<string, unknown> | string;
};

function readAfter(row: MovementRow): Record<string, unknown> {
  if (typeof row.after_json === "string") {
    try {
      return JSON.parse(row.after_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return row.after_json ?? {};
}

/**
 * Move a movimentação pela sua vida e, ao aplicar, altera o contrato.
 *
 * Aplicar é a única transição que escreve no cadastro, e escreve na mesma
 * transação que marca a movimentação como aplicada. Separar as duas deixaria a
 * porta aberta para um contrato alterado sem histórico correspondente, que é
 * exatamente o problema que a movimentação existe para resolver.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id, movementId } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "contractors.manage");

    const profile = await requireContractorProfile(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, profile.company_id);

    const movement = await d1.prepare(`SELECT id, movement_type, effective_date, status, after_json
      FROM fdp_contractor_movements WHERE workspace_id = ? AND provider_id = ? AND id = ?`)
      .bind(workspace.id, id, movementId).first<MovementRow>();
    if (!movement) throw ApiError.notFound("Movimentação não encontrada.", "MOVEMENT_NOT_FOUND");

    const target = cleanText(body.status, 30) as MovementStatus;
    if (!ALLOWED.includes(target)) throw ApiError.badRequest("Situação inválida.", "INVALID_ENUM");
    assertMovementTransition(movement.status as MovementStatus, target);

    const comment = cleanText(body.comment, 400);
    if (target === "rejected" && !comment) {
      throw ApiError.badRequest("Explique por que a movimentação foi recusada.", "MOVEMENT_REASON_REQUIRED");
    }

    const statements = [];

    if (target === "applied") {
      const after = readAfter(movement);
      const nextBase = after.baseAmountCents === undefined
        ? centsFromDatabase(profile.base_amount, "Valor fixo") : Number(after.baseAmountCents);
      const nextTotal = after.contractTotalCents === undefined
        ? (profile.contract_total_amount === null || profile.contract_total_amount === undefined
          ? null : centsFromDatabase(profile.contract_total_amount, "Valor do contrato"))
        : (after.contractTotalCents === null ? null : Number(after.contractTotalCents));
      const nextEnd = after.contractEnd === undefined
        ? profile.contract_end : (after.contractEnd === null ? null : String(after.contractEnd));
      const nextStatus = after.status === undefined ? profile.status : String(after.status);
      const nextComplement = after.complementMethod === undefined
        ? profile.complement_method : String(after.complementMethod);
      const nextLimit = after.invoiceLimitCents === undefined
        ? (profile.invoice_limit_override === null || profile.invoice_limit_override === undefined
          ? null : centsFromDatabase(profile.invoice_limit_override, "Limite da nota"))
        : (after.invoiceLimitCents === null ? null : Number(after.invoiceLimitCents));

      // O contrato resultante precisa continuar coerente — uma prorrogação que
      // apague a data de término de um contrato determinado o deixaria sem
      // saldo a acompanhar.
      assertContractCoherent({
        contractType: profile.contract_type as ContractType,
        contractStart: profile.contract_start,
        contractEnd: nextEnd,
        contractTotalCents: nextTotal,
      });
      const balance = await contractorBalance(d1, workspace.id, profile);
      assertContractValueNotBelowConsumed(nextTotal, balance.consumedCents);

      statements.push(d1.prepare(`UPDATE fdp_contractor_profiles
          SET base_amount = ?, contract_total_amount = ?, contract_end = ?, status = ?,
              complement_method = ?, invoice_limit_override = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND provider_id = ?`)
        .bind(fromCents(nextBase), nextTotal === null ? null : fromCents(nextTotal), nextEnd, nextStatus,
          nextComplement, nextLimit === null ? null : fromCents(nextLimit), user.id, workspace.id, id));
      // A identidade acompanha o encerramento: prestador inativo não deve
      // aparecer como fornecedor ativo em outras telas.
      statements.push(d1.prepare("UPDATE fdp_auxiliary_providers SET status = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
        .bind(nextStatus === "inactive" ? "inactive" : "active", workspace.id, id));
    }

    statements.push(d1.prepare(`UPDATE fdp_contractor_movements
        SET status = ?, decided_by = ?, decided_at = now(), decision_comment = ?,
            applied_at = CASE WHEN ? = 'applied' THEN now() ELSE applied_at END, updated_at = now()
      WHERE workspace_id = ? AND provider_id = ? AND id = ?`)
      .bind(target, user.id, comment, target, workspace.id, id, movementId));

    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `contractor_movement.${target}`, entityType: "contractor", entityId: id,
      before: { movementId, status: movement.status },
      after: { movementId, status: target, change: target === "applied" ? readAfter(movement) : undefined },
      metadata: { movementType: movement.movement_type, effectiveDate: movement.effective_date },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    await d1.batch(statements);
    return Response.json({ movement: { id: movementId, status: target } });
  } catch (error) {
    return apiError(error);
  }
}
