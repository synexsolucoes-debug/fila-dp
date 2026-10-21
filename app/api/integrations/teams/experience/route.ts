import { apiError, text } from "@/lib/fila-dp-api";
import { prepareAuditEvent } from "@/lib/fila-dp-db";
import { ApiError } from "@/lib/api-errors";
import { authenticateTeamsForm, parseExperienceDecision } from "@/lib/teams-forms";

/**
 * Pergunta de experiência ao gestor pelo Teams (Fase 4).
 *
 * GET: as perguntas pendentes — experiências que vencem nos próximos 10 dias
 * (ou já venceram sem decisão), com o e-mail do gestor. Um fluxo agendado do
 * Power Automate lê esta lista e manda ao gestor o card "efetivar, prorrogar
 * ou desligar?".
 *
 * POST: a resposta do card — `alertId`, `decision`, `note`, `answeredBy`
 * (e-mail de quem respondeu). Fica registrada no alerta e na auditoria.
 */
export async function GET(request: Request) {
  try {
    const { d1, workspaceId } = await authenticateTeamsForm(request);
    const rows = await d1.prepare(`SELECT a.id, a.alert_type, a.due_date::text AS due_date, a.manager_email, a.title,
        e.full_name, COALESCE(NULLIF(co.trade_name, ''), co.legal_name, '') AS company_name
      FROM fdp_dp_alerts a
      JOIN fdp_employees e ON e.workspace_id = a.workspace_id AND e.id = a.employee_id
      LEFT JOIN fdp_companies co ON co.workspace_id = a.workspace_id AND co.id = a.company_id
      WHERE a.workspace_id = ? AND a.status = 'open' AND a.alert_type IN ('experience_45', 'experience_90') AND a.manager_email <> ''
      ORDER BY a.due_date LIMIT 200`).bind(workspaceId).all<Record<string, unknown>>();
    return Response.json({
      questions: rows.results.map((row) => ({
        alertId: String(row.id),
        employeeName: String(row.full_name),
        companyName: String(row.company_name ?? ""),
        milestone: row.alert_type === "experience_45" ? 45 : 90,
        deadline: String(row.due_date).slice(0, 10),
        managerEmail: String(row.manager_email),
        question: `${String(row.full_name)}: experiência de ${row.alert_type === "experience_45" ? 45 : 90} dias vence em ${String(row.due_date).slice(8, 10)}/${String(row.due_date).slice(5, 7)}. Efetivar, prorrogar ou desligar?`,
        options: ["efetivar", "prorrogar", "desligar"],
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const { d1, workspaceId } = await authenticateTeamsForm(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const alertId = text(body.alertId, 120);
    const decision = parseExperienceDecision(body.decision);
    const answeredBy = text(body.answeredBy, 200).toLowerCase();
    if (!alertId || !decision) throw ApiError.badRequest("Informe o alerta e a decisão (efetivar, prorrogar ou desligar).", "TEAMS_EXPERIENCE_INVALID");
    const alert = await d1.prepare("SELECT status, alert_type, manager_email FROM fdp_dp_alerts WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, alertId).first<{ status: string; alert_type: string; manager_email: string }>();
    if (!alert || !alert.alert_type.startsWith("experience_")) throw ApiError.notFound("Pergunta de experiência não encontrada.", "TEAMS_EXPERIENCE_NOT_FOUND");
    if (alert.status === "answered") return Response.json({ alreadyAnswered: true });
    await d1.batch([
      d1.prepare(`UPDATE fdp_dp_alerts SET status = 'answered', decision = ?, decision_note = ?, decision_source = 'teams',
          decided_by = ?, decided_at = now(), updated_at = now() WHERE workspace_id = ? AND id = ? AND status <> 'answered'`)
        .bind(decision, text(body.note, 500), answeredBy || alert.manager_email || "teams", workspaceId, alertId),
      prepareAuditEvent({
        workspaceId, actorType: "integration", actorEmail: answeredBy || "teams",
        action: "dp_alert.decided", entityType: "dp_alert", entityId: alertId,
        after: { decision, source: "teams" },
      }),
    ]);
    return Response.json({ decision, message: `Resposta registrada: ${decision}.` });
  } catch (error) { return apiError(error); }
}
