import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { requiredPaymentEnum } from "@/lib/payments";
import { assertHourEventTarget, hourEventUnits } from "@/lib/time-tracking";

type Params = { params: Promise<{ id: string }> };

/**
 * Ajusta um mapeamento existente.
 *
 * Desativar um mapeamento é permitido e tem consequência declarada: o evento
 * volta a bloquear a exportação até que outro destino seja configurado.
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.mappings.manage");

    const current = await d1.prepare(`SELECT id, company_id, destination, event_code, rubric_code, target_field, unit, status
      FROM fdp_hour_event_mappings WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Mapeamento não encontrado.", "HOUR_EVENT_MAPPING_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));

    const targetField = body.targetField === undefined ? String(current.target_field) : assertHourEventTarget(body.targetField);
    const unit = body.unit === undefined ? String(current.unit) : requiredPaymentEnum(body.unit, hourEventUnits, "Unidade da quantidade");
    const rubricCode = body.rubricCode === undefined ? String(current.rubric_code) : cleanText(body.rubricCode, 60);
    if (!rubricCode) throw ApiError.badRequest("Informe o código da rubrica no destino.", "RUBRIC_CODE_REQUIRED");
    const status = body.status === undefined ? String(current.status) : (body.status === "inactive" ? "inactive" : "active");

    const saved = await d1.prepare(`UPDATE fdp_hour_event_mappings SET rubric_code = ?, target_field = ?, unit = ?, status = ?,
        note = COALESCE(?, note), updated_at = now()
      WHERE workspace_id = ? AND id = ?
      RETURNING id, event_code, rubric_code, target_field, unit, destination, status`)
      .bind(rubricCode, targetField, unit, status, body.note === undefined ? null : cleanText(body.note, 240), workspace.id, id)
      .first<Record<string, unknown>>();

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "hour_event_mapping.updated", entityType: "hour_event_mapping", entityId: id,
      before: { rubricCode: current.rubric_code, targetField: current.target_field, unit: current.unit, status: current.status },
      after: { rubricCode, targetField, unit, status },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ mapping: saved });
  } catch (error) {
    return apiError(error);
  }
}
