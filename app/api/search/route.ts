import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, board } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const processType = (url.searchParams.get("processType") ?? "").trim().slice(0, 40);
    const slaStatus = (url.searchParams.get("slaStatus") ?? "").trim().slice(0, 20);
    const archived = url.searchParams.get("archived");
    const conditions = ["c.board_id = ?"];
    const values: unknown[] = [board.id];
    if (q) {
      const term = `%${q}%`;
      conditions.push(`(c.title LIKE ? OR c.description LIKE ? OR c.company LIKE ? OR c.assignee_name LIKE ? OR c.process_type LIKE ?
        OR EXISTS (SELECT 1 FROM fdp_custom_field_values cv WHERE cv.card_id = c.id AND cv.value_text LIKE ?)
        OR EXISTS (SELECT 1 FROM fdp_card_assignees ca JOIN fdp_users u ON u.id = ca.user_id WHERE ca.card_id = c.id AND (u.name LIKE ? OR u.email LIKE ?))
        OR EXISTS (SELECT 1 FROM fdp_card_labels cl JOIN fdp_labels l ON l.id = cl.label_id WHERE cl.card_id = c.id AND l.name LIKE ?))`);
      values.push(term, term, term, term, term, term, term, term, term);
    }
    if (processType) { conditions.push("c.process_type = ?"); values.push(processType); }
    if (slaStatus) { conditions.push("c.sla_status = ?"); values.push(slaStatus); }
    if (archived === "true" || archived === "false") { conditions.push("c.archived = ?"); values.push(archived === "true" ? 1 : 0); }
    const result = await d1.prepare(`SELECT c.id, c.title, c.company, c.process_type, c.priority, c.sla_status, c.due_at, c.assignee_name, c.archived, c.list_id
      FROM fdp_cards c WHERE ${conditions.join(" AND ")} ORDER BY c.archived, c.updated_at DESC LIMIT 50`).bind(...values).all<Record<string, unknown>>();
    return Response.json({
      results: result.results.map((row) => ({
        id: String(row.id), title: String(row.title), company: String(row.company ?? ""), processType: String(row.process_type), priority: String(row.priority), slaStatus: String(row.sla_status), dueAt: row.due_at ? String(row.due_at) : null, assigneeName: String(row.assignee_name ?? ""), archived: Boolean(row.archived), listId: String(row.list_id),
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}
