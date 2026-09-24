import { getScopedD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { prepareAuditEvent } from "@/lib/fila-dp-db";
import { ApiError } from "@/lib/api-errors";
import { clientAddress, consumePublicAuthRateLimit } from "@/lib/auth-rate-limit";
import { cleanText } from "@/lib/registrations";
import { prepareSignDelivery } from "@/lib/epi-service";
import {
  assertEpiAckLinkUsable, epiAckLinkStatus, hashPortalToken, parsePortalToken, samePortalHash,
} from "@/lib/epi-delivery-ack-link";

type Params = { params: Promise<{ token: string }> };

/**
 * O link de ciência de entrega de EPI: ler o que foi entregue e confirmar,
 * sem conta e sem senha.
 *
 * Mesmo desenho do portal do prestador (`/api/portal/nota/[token]`): o
 * inquilino vem do token, a conexão nasce presa a ele, toda recusa é a mesma
 * recusa (404 genérico), e a resposta carrega o mínimo — o que o colaborador
 * já sabia (o EPI, a quantidade, a data), nenhum outro dado da empresa.
 */

const genericNotFound = () => ApiError.notFound(
  "Este link não é válido. Confira o endereço recebido ou procure o DP.",
  "EPI_ACK_LINK_NOT_FOUND",
);

type LinkRow = {
  id: string; workspace_id: string; company_id: string; delivery_id: string;
  token_hash: string; expires_at: string; acknowledged_at: string | null; revoked_at: string | null;
  product_name: string; ca_number: string; size: string; quantity: number;
  delivered_on: string; delivery_status: string; employee_name: string;
};

async function resolveLink(rawToken: string, request: Request) {
  const parsed = parsePortalToken(rawToken);
  if (!parsed) throw genericNotFound();

  const limite = await consumePublicAuthRateLimit("epi_ack_portal", parsed.secret.slice(0, 32), clientAddress(request));
  if (!limite.allowed) {
    throw new ApiError(429, "EPI_ACK_RATE_LIMITED",
      "Muitas tentativas neste link. Aguarde alguns minutos e tente de novo.",
      { retryAfterSeconds: limite.retryAfterSeconds });
  }

  const hash = hashPortalToken(parsed.workspaceId, parsed.secret);
  const d1 = getScopedD1({ workspaceId: parsed.workspaceId });
  const link = await d1.prepare(`SELECT link.id, link.workspace_id, link.company_id, link.delivery_id,
      link.token_hash, link.expires_at, link.acknowledged_at, link.revoked_at,
      product.name AS product_name, delivery.ca_number, delivery.size, delivery.quantity,
      delivery.delivered_on, delivery.status AS delivery_status,
      COALESCE(NULLIF(employee.social_name, ''), employee.full_name) AS employee_name
    FROM fdp_epi_delivery_ack_links link
    JOIN fdp_epi_deliveries delivery ON delivery.workspace_id = link.workspace_id AND delivery.id = link.delivery_id
    JOIN fdp_epi_products product ON product.workspace_id = link.workspace_id AND product.id = delivery.product_id
    JOIN fdp_employees employee ON employee.workspace_id = link.workspace_id AND employee.id = delivery.employee_id
    WHERE link.workspace_id = ? AND link.token_hash = ?`)
    .bind(parsed.workspaceId, hash)
    .first<LinkRow>();

  if (!link || !samePortalHash(link.token_hash, hash)) throw genericNotFound();
  return { d1, link };
}

const portalPayload = (link: LinkRow) => ({
  employeeName: link.employee_name,
  productName: link.product_name,
  caNumber: link.ca_number,
  size: link.size,
  quantity: Number(link.quantity ?? 0),
  deliveredOn: link.delivered_on,
  expiresAt: link.expires_at,
});

export async function GET(request: Request, { params }: Params) {
  try {
    const { token } = await params;
    const { d1, link } = await resolveLink(token, request);

    await d1.prepare(`UPDATE fdp_epi_delivery_ack_links
        SET opened_count = opened_count + 1, first_opened_at = COALESCE(first_opened_at, now()), updated_at = now()
      WHERE workspace_id = ? AND id = ?`)
      .bind(link.workspace_id, link.id)
      .run();

    return Response.json({
      portal: portalPayload(link),
      status: epiAckLinkStatus(link),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { token } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, link } = await resolveLink(token, request);
    assertEpiAckLinkUsable(link);

    if (link.delivery_status === "canceled") {
      throw ApiError.badRequest("Esta entrega foi cancelada. Procure o DP antes de confirmar.", "EPI_DELIVERY_CANCELED");
    }
    const signatureName = cleanText(body.signatureName, 160);
    if (!signatureName) throw ApiError.badRequest("Informe seu nome para confirmar.", "EPI_SIGNATURE_REQUIRED");

    /* O fechamento do link é a condição do WHERE, não uma segunda checagem:
       é o que impede duas confirmações simultâneas de assinarem a entrega
       duas vezes. */
    const closed = await d1.prepare(`UPDATE fdp_epi_delivery_ack_links
        SET acknowledged_at = now(), updated_at = now()
      WHERE workspace_id = ? AND id = ? AND acknowledged_at IS NULL AND revoked_at IS NULL
      RETURNING id`)
      .bind(link.workspace_id, link.id)
      .first<{ id: string }>();
    if (!closed) {
      throw new ApiError(409, "EPI_ACK_LINK_ACKNOWLEDGED",
        "Esta entrega já havia sido confirmada. Procure o DP se algo estiver errado.");
    }

    await d1.batch([
      prepareSignDelivery(d1, {
        workspaceId: link.workspace_id, deliveryId: link.delivery_id,
        signatureName, updatedBy: "epi_ack_portal",
      }),
      prepareAuditEvent({
        workspaceId: link.workspace_id, actorType: "system", actorEmail: signatureName,
        action: "epi_delivery.updated", entityType: "epi_delivery", entityId: link.delivery_id,
        after: { status: "signed", signatureName },
        metadata: { signed: true, via: "epi_ack_portal", ackLinkId: link.id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ acknowledged: { signatureName } }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
