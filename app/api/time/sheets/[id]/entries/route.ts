import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertTimeSheetMutable, parseTimeEntryPayload } from "@/lib/time-tracking";
import { findTimeSheet, recalculateTimeSheet, saveTimeEntries } from "@/lib/time-service";

type Params = { params: Promise<{ id: string }> };

const MAX_DAYS = 40;

/** Marcações do cartão de ponto da competência, dia a dia. */
export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "time.read");
    const sheet = await findTimeSheet(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, sheet.company_id);

    const [entries, events, issues] = await Promise.all([
      d1.prepare(`SELECT id, entry_date, day_type, expected_minutes, worked_minutes, night_minutes, balance_minutes,
          punches_json, origin, justification, note
        FROM fdp_time_entries WHERE workspace_id = ? AND time_sheet_id = ? ORDER BY entry_date`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare("SELECT id, event_code, minutes, source, justification FROM fdp_time_sheet_events WHERE workspace_id = ? AND time_sheet_id = ? ORDER BY event_code")
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, entry_date, kind, severity, detail, status, resolution_note, resolved_at
        FROM fdp_time_inconsistencies WHERE workspace_id = ? AND time_sheet_id = ? ORDER BY severity, entry_date, kind`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
    ]);
    return Response.json({ sheet, entries: entries.results, events: events.results, inconsistencies: issues.results });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Grava ou corrige as marcações de um ou mais dias e reapura a folha.
 *
 * Toda escrita é seguida de recálculo: os totais e as inconsistências gravados
 * nunca ficam defasados em relação às marcações que os originam.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "time.manage");

    const sheet = await findTimeSheet(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, sheet.company_id);
    assertTimeSheetMutable(sheet.status);

    const raw = Array.isArray(body.entries) ? body.entries : [body];
    if (!raw.length) throw ApiError.badRequest("Envie ao menos um dia de marcação.", "TIME_ENTRIES_REQUIRED");
    if (raw.length > MAX_DAYS) throw ApiError.badRequest(`Envie no máximo ${MAX_DAYS} dias por requisição.`, "REQUEST_TOO_LARGE");

    const entries = raw.map((item) => parseTimeEntryPayload(item, "manual"));
    const today = new Date().toISOString().slice(0, 10);
    await saveTimeEntries(d1, {
      workspaceId: workspace.id, companyId: sheet.company_id, sheetId: id, employeeId: sheet.employee_id,
      entries, userId: user.id, today,
    });
    const recalculated = await recalculateTimeSheet(d1, workspace.id, id, { today });

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "time_entry.saved", entityType: "time_sheet", entityId: id,
      after: { days: entries.map((entry) => entry.entryDate), workedMinutes: recalculated.totals.workedMinutes },
      metadata: { blockingIssues: recalculated.openBlockingIssues },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      saved: entries.length,
      totals: recalculated.totals,
      openBlockingIssues: recalculated.openBlockingIssues,
      openWarningIssues: recalculated.openWarningIssues,
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
