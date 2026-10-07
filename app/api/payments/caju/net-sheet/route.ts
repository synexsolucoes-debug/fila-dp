import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { centsFromDatabase } from "@/lib/payments";
import { buildCajuNetSheet } from "@/lib/caju-net-sheet";

/**
 * Planilha com nome, documento e valor líquido do complemento Caju.
 *
 * `?fee=1` aplica a taxa de 1,99%. Inclui todo fechamento com complemento > 0,
 * com a situação na linha: é conferência, não pedido à Caju.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const url = new URL(request.url);
    const cycleId = url.searchParams.get("competenceId") ?? "";
    if (!cycleId) throw ApiError.badRequest("Informe a competência a exportar.", "CAJU_COMPETENCE_REQUIRED");
    const applyFee = url.searchParams.get("fee") === "1";

    const { d1, workspace, user: actor } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.export_caju");
    const cycle = await d1.prepare("SELECT id, company_id, competence FROM fdp_payroll_cycles WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, cycleId).first<{ id: string; company_id: string; competence: string }>();
    if (!cycle) throw ApiError.notFound("Competência não encontrada.", "PAYROLL_CYCLE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, actor.id, workspace.role, cycle.company_id);

    const rows = await d1.prepare(`SELECT c.status, c.caju_amount, p.legal_name, p.trade_name, p.tax_id
      FROM fdp_contractor_closings c
      JOIN fdp_auxiliary_providers p ON p.workspace_id = c.workspace_id AND p.id = c.provider_id
      WHERE c.workspace_id = ? AND c.payroll_cycle_id = ? AND c.excluded_at IS NULL
      ORDER BY p.legal_name`).bind(workspace.id, cycleId)
      .all<{ status: string; caju_amount: string; legal_name: string; trade_name: string; tax_id: string }>();

    const items = rows.results
      .map((row) => ({
        name: row.trade_name || row.legal_name, taxId: row.tax_id, status: row.status,
        amountCents: centsFromDatabase(row.caju_amount, "Valor destinado à Caju"),
      }))
      .filter((row) => row.amountCents > 0);
    if (items.length === 0) {
      throw new ApiError(409, "CAJU_EXPORT_EMPTY", "Nenhum prestador desta competência tem complemento Caju.");
    }

    const { buffer, totals } = await buildCajuNetSheet(items, { applyFee });
    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: actor.id, actorEmail: auth.user.email,
      action: "caju_net_sheet.generated", entityType: "payroll_cycle", entityId: cycle.id, before: null,
      after: { rows: items.length, applyFee, ...totals }, metadata: { competence: cycle.competence },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="complemento_caju_${cycle.competence.replace(/[^0-9a-z-]/giu, "")}${applyFee ? "_liquido" : ""}.xlsx"`,
        "Cache-Control": "no-store",
        "X-Caju-Rows": String(items.length),
        "X-Caju-Total-Cents": String(applyFee ? totals.net : totals.amount),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
