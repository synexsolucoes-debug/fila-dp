import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { refreshDpAlerts } from "@/lib/dp-alerts-service";
import { todayInBrazil } from "@/lib/employee-history";

/** Recalcula os alertas agora — o mesmo que o job diário faz. */
export async function POST() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "recalcular os alertas do DP");
    return Response.json(await refreshDpAlerts(d1, { workspaceId: workspace.id, today: todayInBrazil() }));
  } catch (error) { return apiError(error); }
}
