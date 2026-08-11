import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";
import { requiredPaymentEnum } from "@/lib/payments";
import { assertTimeSheetMutable } from "@/lib/time-tracking";
import { decideInconsistency, findTimeSheet, recalculateTimeSheet } from "@/lib/time-service";

type Params = { params: Promise<{ id: string }> };

/**
 * Registra a decisão humana sobre uma inconsistência do ponto.
 *
 * `resolved` significa "o dado foi corrigido"; `waived` significa "está certo
 * assim e eis o porquê". Ambos exigem nota — uma inconsistência que some sem
 * explicação é uma conferência que não aconteceu.
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

    const status = requiredPaymentEnum(body.status, ["resolved", "waived"] as const, "Decisão da inconsistência");
    const decision = await decideInconsistency(d1, {
      workspaceId: workspace.id,
      sheetId: id,
      inconsistencyId: cleanText(body.inconsistencyId, 120),
      status,
      note: cleanText(body.note, 500),
      userId: user.id,
    });

    // A contagem gravada na folha precisa refletir a decisão imediatamente.
    const openIssues = await d1.prepare(`SELECT
        count(*) FILTER (WHERE severity = 'blocking' AND status = 'open')::int AS blocking,
        count(*) FILTER (WHERE severity = 'warning' AND status = 'open')::int AS warning
      FROM fdp_time_inconsistencies WHERE workspace_id = ? AND time_sheet_id = ?`)
      .bind(workspace.id, id).first<{ blocking: number; warning: number }>();
    await d1.prepare("UPDATE fdp_time_sheets SET blocking_issues = ?, warning_issues = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
      .bind(Number(openIssues?.blocking ?? 0), Number(openIssues?.warning ?? 0), workspace.id, id).run();

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `time_inconsistency.${status}`, entityType: "time_inconsistency", entityId: decision.id,
      after: { sheetId: id, kind: decision.kind, status },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({
      inconsistency: decision,
      openBlockingIssues: Number(openIssues?.blocking ?? 0),
      openWarningIssues: Number(openIssues?.warning ?? 0),
    });
  } catch (error) {
    return apiError(error);
  }
}

/** Recalcula a folha inteira a partir das marcações gravadas. */
export async function PUT(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.manage");
    const sheet = await findTimeSheet(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, sheet.company_id);
    assertTimeSheetMutable(sheet.status);

    const recalculated = await recalculateTimeSheet(d1, workspace.id, id);
    return Response.json({
      totals: recalculated.totals,
      openBlockingIssues: recalculated.openBlockingIssues,
      openWarningIssues: recalculated.openWarningIssues,
    });
  } catch (error) {
    return apiError(error);
  }
}
