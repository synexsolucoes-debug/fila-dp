import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { createPortalToken, portalExpiryFromDays } from "@/lib/contractor-invoice-portal";
import { epiAckLinkUrl } from "@/lib/epi-delivery-ack-link";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Gera o link de ciência da entrega, passo 1 do link assinado genérico.
 *
 * Mesmo raciocínio do portal do prestador: o token completo só existe nesta
 * resposta e na mensagem que vai ao colaborador — o banco guarda o hash.
 * Gerar de novo revoga o link anterior no mesmo lote, porque só um link vivo
 * por entrega faz sentido (o colaborador não deve adivinhar qual usar).
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.deliver", "gerar link de ciência de entrega de EPI");
    const delivery = await d1.prepare("SELECT id, company_id, status FROM fdp_epi_deliveries WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ id: string; company_id: string; status: string }>();
    if (!delivery) throw ApiError.notFound("Entrega não encontrada.", "EPI_DELIVERY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, delivery.company_id);
    if (delivery.status === "canceled") throw ApiError.badRequest("Esta entrega foi cancelada.", "EPI_DELIVERY_CANCELED");
    if (delivery.status === "signed") throw ApiError.badRequest("Esta entrega já foi assinada.", "EPI_DELIVERY_ALREADY_SIGNED");

    const token = createPortalToken(workspace.id);
    const expiresAt = portalExpiryFromDays(body.days);
    const linkId = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`UPDATE fdp_epi_delivery_ack_links
          SET revoked_at = now(), revoked_by = ?, revoke_reason = 'Substituído por um link novo', updated_at = now()
        WHERE workspace_id = ? AND delivery_id = ? AND revoked_at IS NULL AND acknowledged_at IS NULL`)
        .bind(user.id, workspace.id, delivery.id),
      d1.prepare(`INSERT INTO fdp_epi_delivery_ack_links
          (id, workspace_id, company_id, delivery_id, token_hash, expires_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(linkId, workspace.id, delivery.company_id, delivery.id, token.hash, expiresAt.toISOString(), user.id),
      // O token não entra na trilha, pelo mesmo motivo do portal do prestador:
      // auditoria guarda o que aconteceu, não a credencial que o repetiria.
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "epi_delivery_ack_link.created", entityType: "epi_delivery_ack_link", entityId: linkId,
        after: { deliveryId: delivery.id, expiresAt: expiresAt.toISOString() },
        metadata: { scope: "company", companyId: delivery.company_id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ url: epiAckLinkUrl(token.token), expiresAt: expiresAt.toISOString() }, { status: 201 });
  } catch (error) { return apiError(error); }
}
