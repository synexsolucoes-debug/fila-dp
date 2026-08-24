import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, getWorkspaceSnapshot, prepareAuditEvent, recordActivity,
  requireCardCompanyAccess, requireWorkspaceRole,
} from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";

type RouteContext = { params: Promise<{ id: string }> };

type DemandSource = {
  employee_id: string;
  integration_id: string;
  external_admission_id: string;
};

/** Autoriza uma única transferência, para a pessoa já vinculada à demanda. */
export async function POST(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id: cardId } = await context.params;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "attachments.write");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, cardId);

    const card = await d1.prepare(`SELECT id FROM fdp_cards
      WHERE workspace_id = ? AND board_id = ? AND id = ? AND archived = 0`)
      .bind(workspace.id, board.id, cardId).first<{ id: string }>();
    if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");

    // O destino não vem do navegador. Ele é reconstituído do evento que criou
    // o cartão; assim um pedido adulterado não consegue apontar para outra
    // pessoa ou para outro processo da Sólides.
    const source = await d1.prepare(`SELECT employee_id, integration_id, external_admission_id FROM (
        SELECT 1 AS priority,
          event.payload_json->>'employeeId' AS employee_id,
          event.integration_id,
          event.payload_json->>'externalAdmissionId' AS external_admission_id,
          event.processed_at AS linked_at
        FROM fdp_integration_events event
        WHERE event.workspace_id = ? AND event.result_type = 'card' AND event.result_id = ?
          AND event.connector = 'tangerino_browser' AND event.event_type = 'admission.contract_data_ready'
        UNION ALL
        SELECT 2 AS priority,
          consultation.employee_id,
          consultation.integration_id,
          consultation.external_admission_id,
          activity.created_at AS linked_at
        FROM fdp_activity_events activity
        JOIN fdp_tangerino_admission_consultations consultation
          ON consultation.workspace_id = activity.workspace_id
         AND consultation.id = (activity.payload_json::jsonb)->>'consultationId'
        WHERE activity.workspace_id = ? AND activity.card_id = ?
          AND activity.event_type = 'tangerino.erp_demand_created'
      ) source
      WHERE length(COALESCE(employee_id, '')) > 0
        AND length(COALESCE(integration_id, '')) > 0
        AND length(COALESCE(external_admission_id, '')) > 0
      ORDER BY priority, linked_at DESC LIMIT 1`)
      .bind(workspace.id, cardId, workspace.id, cardId).first<DemandSource>();
    if (!source) {
      throw new ApiError(409, "TANGERINO_DEMAND_LINK_MISSING",
        "Esta demanda não possui um vínculo verificável com a admissão da Sólides.");
    }

    const authorizationId = crypto.randomUUID();
    const inserted = await d1.prepare(`WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext(?))
      ), inserted AS (
        INSERT INTO fdp_tangerino_attachment_authorizations
          (id, workspace_id, card_id, employee_id, integration_id, external_admission_id, authorized_by_user_id)
        SELECT ?, ?, ?, ?, ?, ?, ? FROM lock
        WHERE NOT EXISTS (
          SELECT 1 FROM fdp_tangerino_attachment_authorizations existing
          WHERE existing.workspace_id = ? AND existing.card_id = ?
            AND existing.state IN ('QUEUED', 'RUNNING', 'COMPLETED')
        )
        RETURNING id
      ) SELECT id FROM inserted`)
      .bind(`tangerino-attachments:${workspace.id}:${cardId}`, authorizationId, workspace.id, cardId,
        source.employee_id, source.integration_id, source.external_admission_id.slice(0, 120), user.id,
        workspace.id, cardId).first<{ id: string }>();

    if (inserted) {
      await d1.batch([
        prepareAuditEvent({
          workspaceId: workspace.id, actorType: "user", actorEmail: auth.user.email,
          action: "tangerino.attachments.authorized", entityType: "card", entityId: cardId,
          after: { authorizationId, expiresInHours: 24 },
        }),
      ]);
      await recordActivity(workspace.id, cardId, auth.user.email, "tangerino.attachments.authorized", {
        authorizationId, expiresInHours: 24,
      });
    }

    return Response.json(await getWorkspaceSnapshot(auth.user), { status: inserted ? 201 : 200 });
  } catch (error) {
    return apiError(error);
  }
}
