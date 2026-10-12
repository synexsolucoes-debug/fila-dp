import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";
import { companyScopeClause } from "@/lib/erp-dp-service";

/**
 * ERP DP — retroativos abertos (o infotipo 0003 do SAP, sem recálculo).
 *
 * As pendências que `POST /api/operations/movements/[id]/apply` abre quando
 * uma movimentação vale a partir de uma competência já processada. Resolver
 * continua sendo na Operação DP (`PATCH /api/operations/pending-items/[id]`):
 * esta rota só junta o que está aberto no grupo, com a movimentação de origem.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "pending_items.read");
    const companyId = cleanText(new URL(request.url).searchParams.get("companyId"), 120);
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, companyId, "p.company_id");
    if (!scope) return Response.json({ items: [] });
    const result = await d1.prepare(`SELECT p.id, p.company_id, COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name,
        p.title, p.status, p.created_at, m.id AS movement_id, m.movement_type, m.effective_date, m.title AS movement_title,
        e.full_name AS employee_name
      FROM fdp_operational_pending_items p
      JOIN fdp_companies co ON co.workspace_id = p.workspace_id AND co.id = p.company_id
      LEFT JOIN fdp_employee_movements m ON m.workspace_id = p.workspace_id AND m.id = p.source_id
      LEFT JOIN fdp_employees e ON e.workspace_id = m.workspace_id AND e.id = m.employee_id
      WHERE p.workspace_id = ? AND p.idempotency_key LIKE 'retro:%' AND ${scope.clause}
      ORDER BY (p.status IN ('open', 'in_progress')) DESC, p.created_at DESC LIMIT 200`)
      .bind(workspace.id, ...scope.values).all<Record<string, unknown>>();
    return Response.json({ items: result.results });
  } catch (error) { return apiError(error); }
}
