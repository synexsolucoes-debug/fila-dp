import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { parseExperienceDecision } from "@/lib/teams-forms";

/**
 * Registra a decisão de experiência pelo painel — quando o gestor respondeu
 * por outro canal e o DP anota aqui. Pelo Teams, a resposta chega por
 * `/api/integrations/teams/experience`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "registrar a decisão de experiência");
    const decision = parseExperienceDecision(body.decision);
    if (!decision) throw ApiError.badRequest("Decisão inválida: efetivar, prorrogar ou desligar.", "DP_ALERT_DECISION_INVALID");
    const alert = await d1.prepare("SELECT alert_type, company_id, status FROM fdp_dp_alerts WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ alert_type: string; company_id: string | null; status: string }>();
    if (!alert) throw ApiError.notFound("Alerta não encontrado.", "DP_ALERT_NOT_FOUND");
    if (!alert.alert_type.startsWith("experience_")) throw ApiError.badRequest("Só alerta de experiência recebe decisão.", "DP_ALERT_NOT_EXPERIENCE");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, alert.company_id);
    const note = cleanText(body.note, 500);
    await d1.batch([
      d1.prepare(`UPDATE fdp_dp_alerts SET status = 'answered', decision = ?, decision_note = ?, decision_source = 'painel',
          decided_by = ?, decided_at = now(), updated_at = now() WHERE workspace_id = ? AND id = ?`)
        .bind(decision, note, user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "dp_alert.decided", entityType: "dp_alert", entityId: id,
        before: { status: alert.status }, after: { decision, source: "painel" },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ decision });
  } catch (error) { return apiError(error); }
}
