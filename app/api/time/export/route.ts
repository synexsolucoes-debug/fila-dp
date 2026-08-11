import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { hourEventLabels } from "@/lib/time-tracking";
import { approvedSheetsForExport, hourEventMappings, previewTimeExport, requireOpenTimeCycle, runTimeExport } from "@/lib/time-service";
import { prepareDomainEvent } from "@/lib/outbox";

export const dynamic = "force-dynamic";

/**
 * Prévia da exportação de ponto para a folha.
 *
 * Existe para que o operador veja o bloqueio do §22 antes de tentar exportar:
 * quais eventos foram apurados, quais têm rubrica configurada e quais não têm.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const cycleId = cleanText(url.searchParams.get("competenceId"), 120);
    if (!companyId || !cycleId) throw ApiError.badRequest("Empresa e competência são obrigatórias.", "TIME_EXPORT_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const destination = cleanText(url.searchParams.get("destination"), 60) || "folha";

    const [sheets, mappings] = await Promise.all([
      approvedSheetsForExport(d1, workspace.id, companyId, cycleId),
      hourEventMappings(d1, workspace.id, companyId, destination),
    ]);
    const preview = previewTimeExport({ destination, sheets, mappings });

    return Response.json({
      ...preview,
      approvedSheets: sheets.length,
      blockedBy: preview.missingMappings.map((code) => ({ eventCode: code, label: hourEventLabels[code] })),
      // A prévia não grava nada: só a rota POST cria lote e marca folhas.
      message: preview.ready
        ? "Exportação liberada."
        : preview.missingMappings.length
          ? "Exportação bloqueada: configure a rubrica de destino dos eventos listados."
          : "Não há folha de ponto aprovada com evento de hora apurado nesta competência.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Executa a exportação: grava o lote imutável e marca as folhas aprovadas como
 * exportadas. Sem mapeamento de rubrica, nada é gravado e a resposta nomeia o
 * que falta configurar (§22).
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.export");

    const companyId = cleanText(body.companyId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    if (!companyId || !cycleId) throw ApiError.badRequest("Empresa e competência são obrigatórias.", "TIME_EXPORT_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const cycle = await requireOpenTimeCycle(d1, workspace.id, companyId, cycleId);
    const destination = cleanText(body.destination, 60) || "folha";

    const result = await runTimeExport(d1, {
      workspaceId: workspace.id, companyId, cycle, destination, userId: user.id,
    });

    await d1.batch([
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "time_export.prepared", entityType: "time_export", entityId: result.exportId,
        after: {
          competence: cycle.competence, companyId, destination,
          sheets: result.preview.sheets.length, lines: result.preview.linesCount,
        },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
      prepareDomainEvent(d1, {
        workspaceId: workspace.id,
        eventType: "time_export.prepared",
        entityType: "time_export",
        entityId: result.exportId,
        payload: {
          competence: cycle.competence, companyId, destination,
          sheetsCount: result.preview.sheets.length, linesCount: result.preview.linesCount,
        },
        actorUserId: user.id,
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    if (cleanText(body.format, 10) === "csv") {
      return new Response(result.csv, {
        status: 201,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="ponto-${cycle.competence}-${destination}.csv"`,
          "X-Fila-Dp-Export-Id": result.exportId,
          "Cache-Control": "no-store",
        },
      });
    }

    return Response.json({
      exportId: result.exportId,
      destination,
      competence: cycle.competence,
      sheets: result.preview.sheets.length,
      lines: result.preview.linesCount,
      csv: result.csv,
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
