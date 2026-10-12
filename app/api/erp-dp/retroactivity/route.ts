import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";
import { companyScopeClause } from "@/lib/erp-dp-service";

/**
 * ERP DP — retroativos (o infotipo 0003 do SAP, sem recálculo).
 *
 * Abertos por `POST /api/operations/movements/[id]/apply` e pela medida de
 * retorno do ERP quando a vigência cai numa competência já processada. Moram
 * em `fdp_erp_retroactive_items`, fora das Pendências da Operação DP: o que é
 * ERP fica no ERP (§4.30). Resolver é `PATCH .../retroactivity/[id]`.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "movements.read");
    const companyId = cleanText(new URL(request.url).searchParams.get("companyId"), 120);
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, companyId, "r.company_id");
    if (!scope) return Response.json({ items: [] });
    const result = await d1.prepare(`SELECT r.id, r.company_id, COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name,
        r.title, r.status, r.resolution, r.source_type, r.effective_date, r.competence, r.cycle_status, r.created_at, r.resolved_at,
        m.movement_type, m.title AS movement_title, COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name
      FROM fdp_erp_retroactive_items r
      JOIN fdp_companies co ON co.workspace_id = r.workspace_id AND co.id = r.company_id
      LEFT JOIN fdp_employee_movements m ON r.source_type = 'movement' AND m.workspace_id = r.workspace_id AND m.id = r.source_id
      LEFT JOIN fdp_employees e ON e.workspace_id = r.workspace_id AND e.id = r.employee_id
      WHERE r.workspace_id = ? AND ${scope.clause}
      ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 200`)
      .bind(workspace.id, ...scope.values).all<Record<string, unknown>>();
    return Response.json({ items: result.results });
  } catch (error) { return apiError(error); }
}
