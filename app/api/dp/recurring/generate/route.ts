import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { isCompetence } from "@/lib/dp-calendar";
import { periodsToEnsure } from "@/lib/dp-recurring";
import { generateRecurringTasks } from "@/lib/dp-recurring-service";
import { todayInBrazil } from "@/lib/employee-history";

/**
 * Gera agora as rotinas que faltam — o mesmo que o job diário faz. Com
 * `competencia`, gera as mensais daquela competência (e a semana atual).
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "gerar as rotinas do DP");
    const today = todayInBrazil();
    const periods = isCompetence(body.competencia)
      ? [{ frequency: "monthly" as const, competence: body.competencia }, ...periodsToEnsure(today).filter((period) => period.frequency === "weekly")]
      : undefined;
    const result = await generateRecurringTasks(d1, { workspaceId: workspace.id, today, actor: auth.user.email, periods });
    if (result.created) {
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "recurring_tasks.generated", entityType: "recurring_template", entityId: workspace.id,
        after: { created: result.created, competence: isCompetence(body.competencia) ? body.competencia : null },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
    }
    return Response.json(result);
  } catch (error) { return apiError(error); }
}
