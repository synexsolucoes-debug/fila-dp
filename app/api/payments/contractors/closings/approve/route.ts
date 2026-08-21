import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";

type ClosingRow = {
  id: string;
  company_id: string;
  provider_id: string;
  competence: string;
  status: string;
  net_amount: string | number;
};

/** Aprova vários prestadores em uma única ação, com auditoria individual. */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const ids = [...new Set((Array.isArray(body.closingIds) ? body.closingIds : [])
      .map((value) => cleanText(value, 120)).filter(Boolean))];
    if (ids.length === 0) throw ApiError.badRequest("Selecione ao menos um prestador para aprovar.", "CONTRACTOR_APPROVAL_SELECTION_REQUIRED");
    if (ids.length > 250) throw ApiError.badRequest("Aprove no máximo 250 prestadores por vez.", "CONTRACTOR_APPROVAL_SELECTION_TOO_LARGE");

    const placeholders = ids.map(() => "?").join(", ");
    const candidates = await d1.prepare(`SELECT id, company_id, provider_id, competence, status, net_amount
      FROM fdp_contractor_closings
      WHERE workspace_id = ? AND id IN (${placeholders}) AND excluded_at IS NULL`)
      .bind(workspace.id, ...ids)
      .all<ClosingRow>();
    if (candidates.results.length !== ids.length) {
      throw ApiError.notFound("Um ou mais fechamentos não foram encontrados.", "CONTRACTOR_CLOSING_NOT_FOUND");
    }
    for (const companyId of new Set(candidates.results.map((row) => row.company_id))) {
      await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    }

    const eligible = candidates.results.filter((row) => row.status === "review" || row.status === "approval");
    if (eligible.length === 0) {
      throw ApiError.badRequest("Os prestadores selecionados não estão em conferência ou aprovação.", "CONTRACTOR_APPROVAL_INVALID_STATUS");
    }
    const eligiblePlaceholders = eligible.map(() => "?").join(", ");
    const updated = await d1.prepare(`UPDATE fdp_contractor_closings
      SET status = 'approved', approved_by = ?, approved_at = now(), updated_at = now()
      WHERE workspace_id = ? AND id IN (${eligiblePlaceholders}) AND excluded_at IS NULL
        AND status IN ('review', 'approval')
      RETURNING id, status`)
      .bind(user.id, workspace.id, ...eligible.map((row) => row.id))
      .all<{ id: string; status: string }>();
    const updatedIds = new Set(updated.results.map((row) => row.id));
    if (updatedIds.size !== eligible.length) {
      throw new ApiError(409, "PAYMENT_CLOSING_CONFLICT", "Um fechamento mudou de estado. Recarregue e tente novamente.");
    }

    await d1.batch(eligible.map((closing) => prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_closing.approved",
      entityType: "contractor_closing",
      entityId: closing.id,
      before: { status: closing.status },
      after: { status: "approved", netAmount: Number(closing.net_amount) },
      metadata: { bulk: true, competence: closing.competence, providerId: closing.provider_id },
      requestId: request.headers.get("x-fila-dp-request-id"),
    })));

    return Response.json({ approvedIds: [...updatedIds], approvedCount: updatedIds.size, skippedCount: ids.length - updatedIds.size });
  } catch (error) {
    return apiError(error);
  }
}
