import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { isIsoDay } from "@/lib/dp-calendar";
import { loadDpDashboard } from "@/lib/dp-dashboard-service";
import { todayInBrazil } from "@/lib/employee-history";

/** Painel da gestão: carga por titular e demandas por área e tipo com % fora do corte. */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar o painel do DP");
    const url = new URL(request.url);
    const today = todayInBrazil();
    const from = isIsoDay(url.searchParams.get("de")) ? String(url.searchParams.get("de")) : `${today.slice(0, 7)}-01`;
    const to = isIsoDay(url.searchParams.get("ate")) ? String(url.searchParams.get("ate")) : today;
    return Response.json(await loadDpDashboard(d1, { workspaceId: workspace.id, from, to }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
