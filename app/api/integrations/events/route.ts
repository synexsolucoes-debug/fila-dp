import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { INTEGRATION_EVENT_STATUS_LABELS, listIntegrationEvents, type IntegrationEventStatus } from "@/lib/integration-events";

export const dynamic = "force-dynamic";

/**
 * Histórico de eventos das integrações do grupo — a tela "Ver logs".
 *
 * O workspace vem da sessão, nunca da query. Um `workspaceId` aceito por
 * parâmetro aqui seria um IDOR direto sobre o histórico de integração de outro
 * cliente, incluindo identificadores externos e mensagens de erro do provedor.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.status.read");

    const url = new URL(request.url);
    const requestedIntegrationId = text(url.searchParams.get("integrationId"), 120);
    // O filtro por integração é conferido contra o grupo antes de virar consulta:
    // sem isso o parâmetro seleciona por id e a RLS vira a única defesa.
    const integrationId = requestedIntegrationId
      ? (await d1.prepare("SELECT id FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
        .bind(workspace.id, requestedIntegrationId).first<{ id: string }>())?.id ?? ""
      : "";

    const events = await listIntegrationEvents(d1, workspace.id, {
      integrationId: integrationId || undefined,
      status: text(url.searchParams.get("status"), 20) || undefined,
      connector: text(url.searchParams.get("connector"), 40) || undefined,
      limit: Number(url.searchParams.get("limit") ?? 50),
    });

    return Response.json({
      events: events.map((event) => ({
        id: event.id,
        integrationId: event.integration_id,
        connector: event.connector,
        eventType: event.event_type,
        externalEventId: event.external_event_id,
        status: event.status,
        statusLabel: INTEGRATION_EVENT_STATUS_LABELS[event.status as IntegrationEventStatus] ?? event.status,
        resultType: event.result_type,
        resultId: event.result_id,
        // Código e mensagem já saem sanitizados do conector; nenhum token,
        // segredo ou stack trace chega até aqui.
        errorCode: event.error_code,
        errorMessage: event.error_message,
        retryCount: event.retry_count,
        receivedAt: event.received_at,
        processedAt: event.processed_at,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}
