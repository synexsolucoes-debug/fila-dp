import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { addDays, isIsoDay, weekStart } from "@/lib/dp-calendar";
import { todayInBrazil } from "@/lib/employee-history";

/**
 * "Minha semana": as demandas abertas da pessoa logada com prazo na semana, e
 * as atrasadas no topo. Inclui os alertas do DP atribuídos a ela (Fase 4).
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar a semana do DP");
    const today = todayInBrazil();
    const requested = new URL(request.url).searchParams.get("inicio") ?? "";
    const monday = weekStart(isIsoDay(requested) ? requested : today);
    const sunday = addDays(monday, 6);
    const [cards, alerts] = await Promise.all([
      d1.prepare(`SELECT c.id, c.title, c.process_type, c.priority, c.due_at, c.company,
          COALESCE(NULLIF(co.trade_name, ''), co.legal_name, c.company) AS company_name, c.source_type,
          to_char(c.due_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS due_day
        FROM fdp_cards c
        JOIN fdp_card_assignees ca ON ca.workspace_id = c.workspace_id AND ca.card_id = c.id AND ca.user_id = ?
        LEFT JOIN fdp_companies co ON co.workspace_id = c.workspace_id AND co.id = c.company_id
        WHERE c.workspace_id = ? AND c.archived = 0 AND c.closed_at IS NULL AND c.sla_status <> 'completed'
          AND c.due_at IS NOT NULL AND (c.due_at AT TIME ZONE 'America/Sao_Paulo')::date <= ?::date
          AND ((c.due_at AT TIME ZONE 'America/Sao_Paulo')::date >= ?::date OR (c.due_at AT TIME ZONE 'America/Sao_Paulo')::date < ?::date)
        ORDER BY c.due_at, c.title LIMIT 300`)
        .bind(user.id, workspace.id, sunday, monday, today).all<Record<string, unknown>>(),
      d1.prepare(`SELECT a.id, a.title, a.alert_type, a.severity, a.due_date::text AS due_day, a.employee_id,
          COALESCE(NULLIF(co.trade_name, ''), co.legal_name, '') AS company_name
        FROM fdp_dp_alerts a LEFT JOIN fdp_companies co ON co.workspace_id = a.workspace_id AND co.id = a.company_id
        WHERE a.workspace_id = ? AND a.assigned_user_id = ? AND a.status = 'open' AND a.due_date IS NOT NULL AND a.due_date <= ?::date
        ORDER BY a.due_date LIMIT 200`)
        .bind(workspace.id, user.id, sunday).all<Record<string, unknown>>(),
    ]);
    const items = [
      ...cards.results.map((row) => ({
        kind: "card" as const, id: String(row.id), title: String(row.title), dueDay: String(row.due_day),
        detail: [row.process_type, row.company_name].filter(Boolean).join(" · "), priority: String(row.priority ?? "normal"),
        recurring: row.source_type === "recurring", href: `/painel/demandas/${encodeURIComponent(String(row.id))}`,
      })),
      ...alerts.results.map((row) => ({
        kind: "alert" as const, id: String(row.id), title: String(row.title), dueDay: String(row.due_day).slice(0, 10),
        detail: String(row.company_name ?? ""), priority: row.severity === "warning" ? "normal" : "high", recurring: false,
        href: row.employee_id ? `/painel/cadastros/${encodeURIComponent(String(row.employee_id))}` : "/painel/dp?aba=alertas",
      })),
    ];
    const overdue = items.filter((item) => item.dueDay < today);
    const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index)).map((day) => ({
      day, items: items.filter((item) => item.dueDay === day && item.dueDay >= today),
    }));
    return Response.json({ today, monday, sunday, overdue, days }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
