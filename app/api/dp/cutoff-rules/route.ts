import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { cutoffKindLabels } from "@/lib/dp-cutoff";
import { loadCutoffRules } from "@/lib/dp-cutoff-service";

/** Regras de corte do grupo: proposta → aprovada → divulgada. Só aprovada e divulgada valem. */
export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar as regras de corte");
    const rules = await loadCutoffRules(d1, workspace.id);
    return Response.json({ rules: rules.map((rule) => ({ ...rule, kindLabel: cutoffKindLabels[rule.kind] })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
