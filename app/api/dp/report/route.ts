import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { isCompetence, previousCompetence } from "@/lib/dp-calendar";
import { loadMonthlyReportData } from "@/lib/dp-dashboard-service";
import { buildMonthlyReportPdf } from "@/lib/dp-report";
import { sendMonthlyDpReport } from "@/lib/dp-report-service";
import { todayInBrazil } from "@/lib/employee-history";

/** Baixa o PDF do relatório mensal de uma competência (`?competencia=AAAA-MM`). */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "baixar o relatório do DP");
    const today = todayInBrazil();
    const requested = new URL(request.url).searchParams.get("competencia");
    const period = isCompetence(requested) ? requested : previousCompetence(today.slice(0, 7));
    const pdf = buildMonthlyReportPdf(await loadMonthlyReportData(d1, { workspaceId: workspace.id, period, today }), today);
    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "dp_report.downloaded", entityType: "dp_report", entityId: period, after: { period },
    }).run();
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="relatorio-dp-${period}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) { return apiError(error); }
}

/** Envia agora o relatório de uma competência aos destinatários configurados. */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "enviar o relatório do DP");
    const today = todayInBrazil();
    const period = isCompetence(body.competencia) ? body.competencia : previousCompetence(today.slice(0, 7));
    const result = await sendMonthlyDpReport(d1, { workspaceId: workspace.id, today, actor: user.id, period, force: true });
    if (!result.sent) throw ApiError.badRequest(`Relatório não enviado: ${result.reason}.`, "DP_REPORT_NOT_SENT");
    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "dp_report.sent", entityType: "dp_report", entityId: period, after: { period, recipients: result.recipients },
    }).run();
    return Response.json(result);
  } catch (error) { return apiError(error); }
}
