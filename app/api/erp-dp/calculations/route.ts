import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { calculate } from "@/lib/erp-calculation-service";

/**
 * Cálculo de folha do ERP DP: folha do mês, férias, 13º e rescisão de um
 * colaborador (lib/erp-calculation-service.ts). É simulação: nada é gravado.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    return Response.json(await calculate(d1, workspace, user.id, body));
  } catch (error) { return apiError(error); }
}
