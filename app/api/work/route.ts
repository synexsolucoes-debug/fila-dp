import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { hasCapability } from "@/lib/authorization";
import {
  buildWorkItemQuery, sortWorkItems, toWorkItem, workItemSources,
  type WorkItem, type WorkItemScope,
} from "@/lib/work-items";

/**
 * Central de Trabalho (§31): "o que está comigo hoje?".
 *
 * Uma resposta única sobre os objetos que já existem — demandas, aprovações,
 * movimentações, entregas auxiliares, pendências operacionais e triagem. Nada é
 * migrado nem duplicado: cada item traz o `href` da tela que o resolve.
 *
 * O que a rota **não** faz, de propósito: escrever. Ela é leitura. Resolver o
 * item continua sendo responsabilidade do módulo dono dele, com as regras dele
 * — que é exatamente o que impede esta central de virar um quinto sistema de
 * tarefas por cima dos quatro que já existiam.
 *
 * Cada fonte é consultada só quando a pessoa tem a capacidade correspondente, e
 * o escopo de empresa entra no SQL. Uma fonte a que o usuário não tem acesso
 * simplesmente não é consultada — o custo dela também não é pago.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const scope: WorkItemScope = url.searchParams.get("escopo") === "equipe" ? "team" : "mine";
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limite")) || 50));
    const requested = new Set(
      (url.searchParams.get("fontes") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    );

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const companyIds = access.unrestricted ? null : [...access.companyIds];

    const allowed = workItemSources.filter((source) =>
      hasCapability(workspace, source.capability)
      && (requested.size === 0 || requested.has(source.key)));

    const results = await Promise.all(allowed.map(async (source) => {
      const { sql, parameters } = buildWorkItemQuery({
        source, workspaceId: workspace.id, userId: user.id, scope, companyIds, limit,
      });
      const rows = await d1.prepare(sql).bind(...parameters).all<Record<string, unknown>>();
      return rows.results.map(toWorkItem);
    }));

    const items = sortWorkItems(results.flat());
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.sourceType] = (counts[item.sourceType] ?? 0) + 1;

    return Response.json({
      scope: scope === "mine" ? "meu" : "equipe",
      total: items.length,
      overdue: items.filter((item) => item.tone === "critical").length,
      counts,
      sources: allowed.map((source) => ({ key: source.key, label: source.label })),
      // Fontes que a pessoa não enxerga aparecem nomeadas: esconder sem dizer é
      // o que faz o cliente achar que o produto perdeu dado.
      unavailable: workItemSources
        .filter((source) => !hasCapability(workspace, source.capability))
        .map((source) => ({ key: source.key, label: source.label, reason: "missing_capability" })),
      items: items.slice(0, limit) satisfies WorkItem[],
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
