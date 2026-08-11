import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { requiredPaymentEnum, requiredReason } from "@/lib/payments";
import { assertTimeSheetMutable, computedHourEventCodes, hourEventCodes, hourEventLabels } from "@/lib/time-tracking";
import { findTimeSheet, recalculateTimeSheet } from "@/lib/time-service";

type Params = { params: Promise<{ id: string }> };

const MAX_EVENT_MINUTES = 400 * 60;

/**
 * Lança um evento de hora manual na folha — sobreaviso, banco de horas,
 * intervalo não usufruído.
 *
 * Eventos que o motor apura sozinho não aceitam lançamento manual: sobrescrever
 * a apuração no braço destruiria a rastreabilidade entre marcação e resultado.
 * Para mudar hora extra ou falta, corrija a marcação do dia.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.manage");

    const sheet = await findTimeSheet(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, sheet.company_id);
    assertTimeSheetMutable(sheet.status);

    const eventCode = requiredPaymentEnum(body.eventCode, hourEventCodes, "Evento de hora");
    if (computedHourEventCodes.includes(eventCode)) {
      throw ApiError.badRequest(
        `${hourEventLabels[eventCode]} é apurado a partir das marcações. Corrija o dia em vez de lançar manualmente.`,
        "TIME_EVENT_COMPUTED_ONLY",
      );
    }
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_EVENT_MINUTES) {
      throw ApiError.badRequest("Informe a quantidade de minutos do evento.", "INVALID_TIME_EVENT_MINUTES");
    }
    const justification = requiredReason(body.justification, "TIME_EVENT_JUSTIFICATION_REQUIRED");

    const saved = await d1.prepare(`INSERT INTO fdp_time_sheet_events (id, workspace_id, time_sheet_id, event_code, minutes, source, justification, created_by)
      VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)
      ON CONFLICT (workspace_id, time_sheet_id, event_code) DO UPDATE SET
        minutes = excluded.minutes, source = 'manual', justification = excluded.justification, updated_at = now()
      RETURNING id, event_code, minutes, source, justification`)
      .bind(crypto.randomUUID(), workspace.id, id, eventCode, minutes, justification, user.id)
      .first<Record<string, unknown>>();

    const recalculated = await recalculateTimeSheet(d1, workspace.id, id);

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "time_event.manual", entityType: "time_sheet", entityId: id,
      after: { eventCode, minutes },
      metadata: { justificationProvided: true },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ event: saved, totals: recalculated.totals }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
