import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { cutoffStatuses, ruleFromRow } from "@/lib/dp-cutoff";

/**
 * Ajusta uma regra de corte: status (proposta, aprovada, divulgada), valor,
 * janela do mês e descrição. Vale para as demandas criadas daqui em diante —
 * o veredito das já criadas é imutável.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { code } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "alterar regras de corte");
    const row = await d1.prepare("SELECT * FROM fdp_cutoff_rules WHERE workspace_id = ? AND code = ?").bind(workspace.id, code).first<Record<string, unknown>>();
    if (!row) throw ApiError.notFound("Regra não encontrada.", "CUTOFF_RULE_NOT_FOUND");
    const before = ruleFromRow(row);
    const status = body.status === undefined ? before.status : String(body.status);
    if (!(cutoffStatuses as readonly string[]).includes(status)) throw ApiError.badRequest("Status inválido.", "CUTOFF_RULE_STATUS");
    const value = body.value === undefined ? before.value : Number(body.value);
    if (!Number.isInteger(value) || value < 0 || value > 366) throw ApiError.badRequest("Valor inválido.", "CUTOFF_RULE_VALUE");
    const monthDayLimit = body.monthDayLimit === undefined ? before.monthDayLimit : body.monthDayLimit === null || body.monthDayLimit === "" ? null : Number(body.monthDayLimit);
    if (monthDayLimit !== null && (!Number.isInteger(monthDayLimit) || monthDayLimit < 1 || monthDayLimit > 31)) throw ApiError.badRequest("Dia da janela inválido.", "CUTOFF_RULE_MONTH_DAY");
    const description = body.description === undefined ? before.description : cleanText(body.description, 500);
    await d1.batch([
      d1.prepare(`UPDATE fdp_cutoff_rules SET status = ?, value = ?, month_day_limit = ?, description = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND code = ?`).bind(status, value, monthDayLimit, description, user.id, workspace.id, code),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "cutoff_rule.updated", entityType: "cutoff_rule", entityId: code,
        before: { status: before.status, value: before.value, monthDayLimit: before.monthDayLimit },
        after: { status, value, monthDayLimit }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ updated: true });
  } catch (error) { return apiError(error); }
}
