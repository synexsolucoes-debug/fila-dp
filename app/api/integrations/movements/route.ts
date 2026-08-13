import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { presentSuggestion, type SuggestionRow } from "@/lib/movement-suggestions";

export const dynamic = "force-dynamic";

const columns = `id, workspace_id, integration_id, movement_kind, status, confidence, employee_name, employee_id,
  previous_salary_cents, new_salary_cents, previous_role, new_role, effective_date, requested_by_name,
  team_name, channel_name, message_id, message_url, original_message, missing_fields_json, signals_json,
  card_id, created_at`;

/**
 * Movimentações identificadas no Teams que aguardam validação.
 *
 * Sempre do grupo da sessão. É a fila que o DP revisa quando a interpretação
 * reconheceu a movimentação mas não teve dados suficientes para abrir a demanda
 * sozinha.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "cards.read");

    const url = new URL(request.url);
    const requested = text(url.searchParams.get("status"), 20).toLowerCase();
    const status = ["pending", "confirmed", "rejected", "superseded"].includes(requested) ? requested : "pending";

    const rows = await d1.prepare(
      `SELECT ${columns} FROM fdp_movement_suggestions
        WHERE workspace_id = ? AND status = ?
        ORDER BY created_at DESC LIMIT 100`,
    ).bind(workspace.id, status).all<SuggestionRow>();

    return Response.json({ status, suggestions: rows.results.map(presentSuggestion) });
  } catch (error) {
    return apiError(error);
  }
}
