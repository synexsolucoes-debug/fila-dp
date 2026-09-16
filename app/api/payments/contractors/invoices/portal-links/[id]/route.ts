import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { portalLinkStatus } from "@/lib/contractor-invoice-portal";

type Params = { params: Promise<{ id: string }> };

/**
 * Revoga um link do portal.
 *
 * É a porta de saída de um link que foi para a pessoa errada, ou que o prazo
 * ainda cobre mas não deveria mais valer. O registro não some: ele ganha data,
 * autor e motivo, e a tela passa a mostrá-lo como revogado — apagar deixaria a
 * competência sem explicação para uma nota que nunca chegou.
 *
 * Um link que já recebeu a nota não é revogável. Ele não autoriza mais nada, e
 * marcá-lo como revogado reescreveria o histórico de uma entrega que houve.
 */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.portal.manage");

    const link = await d1.prepare(`SELECT id, company_id, provider_id, competence, expires_at,
        submitted_at, revoked_at FROM fdp_contractor_invoice_portal_links
      WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id)
      .first<{
        id: string; company_id: string; provider_id: string; competence: string;
        expires_at: string; submitted_at: string | null; revoked_at: string | null;
      }>();
    if (!link) throw ApiError.notFound("Link do portal não encontrado.", "PORTAL_LINK_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, link.company_id);

    const situacao = portalLinkStatus(link);
    if (situacao === "submitted") {
      throw ApiError.badRequest(
        "Este link já recebeu a nota fiscal. Para trocar o documento, use a conferência da nota.",
        "PORTAL_LINK_ALREADY_SUBMITTED",
      );
    }
    if (situacao === "revoked") return Response.json({ link: { id, status: "revoked" } });

    const reason = cleanText(new URL(request.url).searchParams.get("reason"), 300);
    const updated = await d1.prepare(`UPDATE fdp_contractor_invoice_portal_links
        SET revoked_at = now(), revoked_by = ?, revoke_reason = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL AND submitted_at IS NULL
      RETURNING id`)
      .bind(user.id, reason, workspace.id, id)
      .first<{ id: string }>();
    if (!updated) {
      // Alguém enviou a nota entre a leitura e a escrita. A condição vive no
      // WHERE justamente para que essa corrida termine sem revogar a entrega.
      throw new ApiError(409, "PORTAL_LINK_CHANGED",
        "A situação deste link mudou enquanto a revogação era processada. Recarregue e confira.");
    }

    await prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_invoice_portal.link_revoked",
      entityType: "contractor_invoice_portal_link",
      entityId: id,
      before: { status: situacao },
      after: { status: "revoked", reason },
      metadata: { companyId: link.company_id, providerId: link.provider_id, competence: link.competence },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ link: { id, status: "revoked" } });
  } catch (error) { return apiError(error); }
}
