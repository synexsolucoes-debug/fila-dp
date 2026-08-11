import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { requireContractorProfile } from "@/lib/payment-service";
import { assertCompetence } from "@/lib/contractor-registry";
import { cleanText } from "@/lib/registrations";

type Params = { params: Promise<{ id: string; itemId: string }> };

/**
 * Encerrar um valor recorrente.
 *
 * Encerrar é datar o fim da vigência, não apagar a linha: as competências já
 * apuradas com esse valor precisam continuar explicáveis. Apagar faria o
 * histórico mentir sobre o que foi pago.
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id, itemId } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.manage");

    const profile = await requireContractorProfile(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, profile.company_id);

    const item = await d1.prepare(`SELECT id, effective_from, effective_to, status
      FROM fdp_contractor_fixed_items WHERE workspace_id = ? AND provider_id = ? AND id = ?`)
      .bind(workspace.id, id, itemId)
      .first<{ id: string; effective_from: string; effective_to: string | null; status: string }>();
    if (!item) throw ApiError.notFound("Valor recorrente não encontrado.", "FIXED_ITEM_NOT_FOUND");

    const effectiveTo = assertCompetence(cleanText(body.effectiveTo, 7), "Competência final");
    if (effectiveTo < item.effective_from) {
      throw ApiError.badRequest(
        "A competência final não pode ser anterior à inicial. Para desfazer um lançamento errado, cancele o componente da competência.",
        "FIXED_ITEM_WINDOW_INVALID",
      );
    }

    await d1.batch([
      d1.prepare(`UPDATE fdp_contractor_fixed_items SET effective_to = ?, status = 'ended', updated_at = now()
        WHERE workspace_id = ? AND provider_id = ? AND id = ?`)
        .bind(effectiveTo, workspace.id, id, itemId),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_fixed_item.ended", entityType: "contractor", entityId: id,
        before: { itemId, effectiveTo: item.effective_to, status: item.status },
        after: { itemId, effectiveTo, status: "ended" },
        metadata: { effectiveFrom: item.effective_from },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
