import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability } from "@/lib/authorization";
import { actionDefinitions, type ActionItem } from "@/lib/action-center";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

/**
 * Central de ação do painel: responde "o que precisa ser feito agora?".
 *
 * Os indicadores são montados a partir do registro declarativo, filtrados pelas
 * capabilities do papel e pelo escopo de empresa do membro, e agregados em uma
 * única ida ao banco — nada de uma consulta por card.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const allowed = actionDefinitions.filter((definition) => hasCapability(workspace.role, definition.capability));
    if (!allowed.length) return Response.json({ items: [], generatedAt: new Date().toISOString() });

    // Um membro sem nenhuma empresa autorizada não enxerga indicador de empresa.
    const scopedCompanyIds = companyId
      ? [companyId]
      : (access.unrestricted ? null : [...access.companyIds]);
    if (scopedCompanyIds && scopedCompanyIds.length === 0) {
      return Response.json({ items: [], generatedAt: new Date().toISOString(), companyScope: "none" });
    }

    const blocks: string[] = [];
    const values: unknown[] = [];
    for (const definition of allowed) {
      // A chave entra no SQL como literal e alias: só identificadores conhecidos.
      if (!/^[a-z][a-z0-9_]*$/u.test(definition.key)) throw new Error(`Indicador com chave inválida: ${definition.key}`);
      let statement = definition.sql;
      const filter = definition.companyColumn && scopedCompanyIds
        ? ` AND ${definition.companyColumn} IN (${scopedCompanyIds.map(() => "?").join(",")})`
        : "";
      statement = statement.replace("{{company}}", filter);
      blocks.push(`SELECT '${definition.key}' AS key, total, earliest, amount FROM (${statement}) AS ${definition.key}_source`);
      values.push(workspace.id);
      if (definition.personal) values.push(user.id);
      if (filter) values.push(...scopedCompanyIds!);
    }

    const rows = await d1.prepare(blocks.join(" UNION ALL "))
      .bind(...values)
      .all<{ key: string; total: number; earliest: string | null; amount: string | number }>();
    const totals = new Map(rows.results.map((row) => [String(row.key), row]));

    const items: ActionItem[] = allowed.map((definition) => {
      const row = totals.get(definition.key);
      return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        tone: definition.tone,
        target: definition.target,
        count: Number(row?.total ?? 0),
        amount: definition.showsAmount ? Number(row?.amount ?? 0) : null,
        earliestDueDate: row?.earliest ? String(row.earliest) : null,
      };
    });

    return Response.json({
      items,
      pendingTotal: items.reduce((total, item) => total + item.count, 0),
      criticalTotal: items.filter((item) => item.tone === "critical").reduce((total, item) => total + item.count, 0),
      companyScope: scopedCompanyIds ? "restricted" : "all",
      generatedAt: new Date().toISOString(),
      // O módulo de Ponto ainda não existe no produto; nenhum indicador é simulado.
      notCovered: ["ponto"],
    });
  } catch (error) {
    return apiError(error);
  }
}
