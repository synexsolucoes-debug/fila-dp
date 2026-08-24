import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { hasCapability } from "@/lib/authorization";
import { recordAdoption } from "@/lib/adoption-metrics";
import {
  buildWorkCenterQuery, buildWorkCountsQuery, buildWorkGroupQuery, cursorForRow,
  decodeWorkCursor, toWorkItem, workItemDueWindows, workItemGroups, workItemSorts, workItemSources,
  WORK_ITEM_DEFAULT_PAGE, WORK_ITEM_MAX_PAGE,
  type WorkItem, type WorkItemDueWindow, type WorkItemFilters, type WorkItemGroup,
  type WorkItemScope, type WorkItemSort, type WorkItemSource,
} from "@/lib/work-items";

/**
 * Central de Trabalho (§3 a §12): "o que está comigo hoje?".
 *
 * Uma resposta única sobre os objetos que já existem — demandas, aprovações,
 * movimentações, entregas auxiliares, pendências operacionais, triagem e as
 * falhas de execução que exigem decisão humana. Nada é migrado nem duplicado:
 * cada item traz o `href` da tela que o resolve.
 *
 * O que a rota **não** faz, de propósito: escrever. Ela é leitura. Resolver o
 * item continua sendo responsabilidade do módulo dono dele, com as regras dele
 * — que é exatamente o que impede esta central de virar um quinto sistema de
 * tarefas por cima dos quatro que já existiam (§1).
 *
 * Cada fonte é consultada só quando a pessoa tem a capacidade correspondente, e
 * o escopo de empresa entra no SQL (§50). Uma fonte a que o usuário não tem
 * acesso simplesmente não é consultada — o custo dela também não é pago.
 *
 * ## Uma ida ao banco por bloco, e não por fonte
 *
 * São no máximo três consultas: a página, os contadores e — só quando pedido —
 * a contagem por grupo. Todas sobre a mesma união. Consultar fonte por fonte
 * multiplicaria o custo pelo número de fontes sem reduzir o tamanho da resposta
 * (§12).
 */

const parseSources = (raw: string): WorkItemSource[] => {
  const requested = new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
  return workItemSources.filter((source) => requested.has(source.key)).map((source) => source.key);
};

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const parameter = (name: string) => (url.searchParams.get(name) ?? "").trim().slice(0, 120);

    const scope: WorkItemScope = parameter("escopo") === "equipe" ? "team" : "mine";
    const limit = Math.max(1, Math.min(WORK_ITEM_MAX_PAGE, Number(url.searchParams.get("limite")) || WORK_ITEM_DEFAULT_PAGE));
    const sort = (workItemSorts.find((item) => item.key === parameter("ordem"))?.key ?? "urgency") as WorkItemSort;
    const group = (workItemGroups.find((item) => item.key === parameter("agrupar"))?.key ?? "") as WorkItemGroup;
    const due = (workItemDueWindows.find((item) => item.key === parameter("prazo"))?.key ?? "") as WorkItemDueWindow;

    const filters: WorkItemFilters = {
      scope, due,
      sources: parseSources(parameter("fontes")),
      companyId: parameter("empresa"),
      processId: parameter("processo"),
      priority: parameter("prioridade"),
      status: parameter("situacao"),
      origin: parameter("origem"),
    };

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const companyIds = access.unrestricted ? null : [...access.companyIds];
    const allowed = workItemSources.filter((source) => hasCapability(workspace, source.capability));

    const shared = {
      sources: allowed, workspaceId: workspace.id, userId: user.id, companyIds,
    };
    const page = buildWorkCenterQuery({ ...shared, filters, sort, cursor: decodeWorkCursor(parameter("cursor")), limit });
    const counts = buildWorkCountsQuery({ ...shared, scope });
    const groups = group ? buildWorkGroupQuery({ ...shared, scope, group: group as Exclude<WorkItemGroup, ""> }) : null;

    const [rows, totals, grouped] = await Promise.all([
      page ? d1.prepare(page.sql).bind(...page.parameters).all<Record<string, unknown>>() : Promise.resolve({ results: [] }),
      counts ? d1.prepare(counts.sql).bind(...counts.parameters).first<Record<string, unknown>>() : Promise.resolve(null),
      groups ? d1.prepare(groups.sql).bind(...groups.parameters).all<Record<string, unknown>>() : Promise.resolve({ results: [] }),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const results = rows.results.slice(0, limit);
    const items: WorkItem[] = results.map((row) => toWorkItem(row, today));
    const nextCursor = rows.results.length > limit && results.length
      ? cursorForRow(sort, results[results.length - 1])
      : "";

    // Adoção (§77): a Central de Trabalho só se justifica se for aberta.
    await recordAdoption(d1, workspace.id, "work_center_opened");

    return Response.json({
      scope: scope === "mine" ? "meu" : "equipe",
      sort,
      group,
      items,
      nextCursor,
      /* Contadores agregados no servidor (§11). Eles cobrem o conjunto inteiro
         do escopo, não a página — um número que muda ao rolar a lista não
         serve para decidir nada. */
      counts: {
        total: Number(totals?.total ?? 0),
        overdue: Number(totals?.overdue ?? 0),
        today: Number(totals?.today ?? 0),
        blocked: Number(totals?.blocked ?? 0),
        awaitingApproval: Number(totals?.awaiting_approval ?? 0),
        triage: Number(totals?.triage ?? 0),
        failures: Number(totals?.failures ?? 0),
      },
      groups: grouped.results.map((row) => ({ key: String(row.grupo ?? ""), total: Number(row.total ?? 0) })),
      sources: allowed.map((source) => ({ key: source.key, label: source.label })),
      // Fontes que a pessoa não enxerga aparecem nomeadas: esconder sem dizer é
      // o que faz o cliente achar que o produto perdeu dado.
      unavailable: workItemSources
        .filter((source) => !hasCapability(workspace, source.capability))
        .map((source) => ({ key: source.key, label: source.label, reason: "missing_capability" })),
      /* O catálogo de filtros e ordenações vai junto: a tela não precisa manter
         uma segunda lista para desalinhar da primeira. */
      options: {
        sorts: workItemSorts,
        groups: workItemGroups,
        dueWindows: workItemDueWindows,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
