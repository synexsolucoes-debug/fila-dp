import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";

export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.read", "consultar opções da Gestão de Processos");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const [areas, members, companies] = await Promise.all([
      d1.prepare(`SELECT id, name, code, status, manager_user_id FROM fdp_areas WHERE workspace_id = ? AND status = 'active' ORDER BY name`).bind(workspace.id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT wm.user_id AS id, u.name, u.email, wm.role FROM fdp_workspace_members wm JOIN fdp_users u ON u.id = wm.user_id WHERE wm.workspace_id = ? ORDER BY u.name, u.email`).bind(workspace.id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, legal_name, trade_name, status FROM fdp_companies WHERE workspace_id = ? ORDER BY status, COALESCE(NULLIF(trade_name, ''), legal_name)`).bind(workspace.id).all<Record<string, unknown>>(),
    ]);
    const visibleCompanies = access.unrestricted ? companies.results : companies.results.filter((row) => access.companyIds.has(String(row.id)));
    return Response.json({
      currentUserId: user.id,
      areas: areas.results.map((row) => ({ id: String(row.id), name: String(row.name), code: String(row.code), status: String(row.status), managerUserId: row.manager_user_id ? String(row.manager_user_id) : "" })),
      members: members.results.map((row) => ({ id: String(row.id), name: String(row.name), email: String(row.email), role: String(row.role) })),
      companies: visibleCompanies.map((row) => ({ id: String(row.id), name: String(row.trade_name || row.legal_name), status: String(row.status) })),
    });
  } catch (error) { return apiError(error); }
}
