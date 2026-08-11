import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { requiredPaymentEnum } from "@/lib/payments";
import { assertHourEventTarget, hourEventCodes, hourEventUnits } from "@/lib/time-tracking";

export const dynamic = "force-dynamic";

/** Mapeamentos de rubrica dos eventos de hora (§22). */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const rows = await d1.prepare(`SELECT id, company_id, destination, event_code, rubric_code, target_field, unit, status, note, updated_at
      FROM fdp_hour_event_mappings WHERE workspace_id = ? AND company_id = ? ORDER BY destination, event_code`)
      .bind(workspace.id, companyId).all<Record<string, unknown>>();
    return Response.json({
      mappings: rows.results,
      // O vocabulário de destino não inclui "valor": não é opção desabilitada, é inexistente.
      targetFields: ["quantity", "reference", "index"],
      units: hourEventUnits,
      eventCodes: hourEventCodes,
    });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Cria o mapeamento de um evento de hora para a rubrica do destino.
 *
 * A regra do §22 é aplicada em três camadas independentes: aqui em
 * `assertHourEventTarget`, no CHECK da tabela e no planejamento da exportação.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.mappings.manage");

    const companyId = cleanText(body.companyId, 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const eventCode = requiredPaymentEnum(body.eventCode, hourEventCodes, "Evento de hora");
    const targetField = assertHourEventTarget(body.targetField);
    const unit = requiredPaymentEnum(body.unit, hourEventUnits, "Unidade da quantidade");
    const rubricCode = cleanText(body.rubricCode, 60);
    if (!rubricCode) throw ApiError.badRequest("Informe o código da rubrica no destino.", "RUBRIC_CODE_REQUIRED");
    const destination = cleanText(body.destination, 60) || "folha";

    const id = crypto.randomUUID();
    const saved = await d1.prepare(`INSERT INTO fdp_hour_event_mappings (id, workspace_id, company_id, destination, event_code,
        rubric_code, target_field, unit, status, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, company_id, destination, event_code) DO UPDATE SET
        rubric_code = excluded.rubric_code, target_field = excluded.target_field, unit = excluded.unit,
        status = excluded.status, note = excluded.note, updated_at = now()
      RETURNING id, event_code, rubric_code, target_field, unit, destination, status`)
      .bind(id, workspace.id, companyId, destination, eventCode, rubricCode, targetField, unit,
        body.status === "inactive" ? "inactive" : "active", cleanText(body.note, 240), user.id)
      .first<Record<string, unknown>>();

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "hour_event_mapping.saved", entityType: "hour_event_mapping", entityId: String(saved?.id ?? id),
      after: { companyId, destination, eventCode, rubricCode, targetField, unit },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ mapping: saved }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
