import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { isCompetence } from "@/lib/dp-calendar";
import { calendarMatrix } from "@/lib/dp-recurring";
import { loadBusinessCalendar, loadRecurringTemplates } from "@/lib/dp-recurring-service";
import { todayInBrazil } from "@/lib/employee-history";

/** Calendário do mês: dias × rotinas, com a carga de cada dia. */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar o calendário do DP");
    const requested = new URL(request.url).searchParams.get("competencia") ?? "";
    const competence = isCompetence(requested) ? requested : todayInBrazil().slice(0, 7);
    const [templates, calendar, generated] = await Promise.all([
      loadRecurringTemplates(d1, workspace.id),
      loadBusinessCalendar(d1, workspace.id),
      d1.prepare(`SELECT o.due_date::text AS due_day, COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE c.closed_at IS NOT NULL OR c.sla_status = 'completed' OR c.archived = 1)::int AS done
        FROM fdp_recurring_occurrences o JOIN fdp_cards c ON c.workspace_id = o.workspace_id AND c.id = o.card_id
        WHERE o.workspace_id = ? AND to_char(o.due_date, 'YYYY-MM') = ? GROUP BY o.due_date`)
        .bind(workspace.id, competence).all<{ due_day: string; total: number; done: number }>(),
    ]);
    return Response.json({
      competence,
      ...calendarMatrix(templates, competence, calendar),
      generated: generated.results.map((row) => ({ day: String(row.due_day).slice(0, 10), total: Number(row.total), done: Number(row.done) })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
