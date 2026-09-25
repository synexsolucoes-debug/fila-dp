import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { prepareAccidentInvestigationDemand } from "@/lib/work-accidents-service";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Abre o plano de ação do acidente — a demanda de investigação (§4.14).
 *
 * Ação própria, e não parte de `PATCH`: corrigir o acidente e decidir que ele
 * precisa de investigação são dois atos diferentes, e o segundo só acontece
 * uma vez — a condição no `WHERE` do UPDATE é o que impede duas demandas para
 * o mesmo acidente se o botão for clicado duas vezes.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "safety.manage", "abrir o plano de ação de um acidente de trabalho");
    const accident = await d1.prepare("SELECT company_id, sector, occurred_on, investigation_card_id FROM fdp_work_accidents WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ company_id: string; sector: string; occurred_on: string; investigation_card_id: string | null }>();
    if (!accident) throw ApiError.notFound("Acidente não encontrado.", "SAFETY_ACCIDENT_NOT_FOUND");
    if (accident.investigation_card_id) {
      throw new ApiError(409, "SAFETY_INVESTIGATION_ALREADY_OPEN", "Este acidente já tem um plano de ação aberto.");
    }
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, accident.company_id);

    const company = await d1.prepare("SELECT trade_name, legal_name FROM fdp_companies WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, accident.company_id).first<{ trade_name: string; legal_name: string }>();
    const demand = await prepareAccidentInvestigationDemand(d1, {
      workspaceId: workspace.id, boardId: board.id, companyId: accident.company_id,
      companyName: company?.trade_name || company?.legal_name || "",
      sector: accident.sector, occurredOn: String(accident.occurred_on).slice(0, 10),
      actorEmail: auth.user.email,
    });

    /* O cartão nasce primeiro, e só depois o acidente aponta para ele — a FK
       de investigation_card_id exige que o cartão já exista. A condição no
       WHERE do UPDATE é a guarda contra duplo clique: se outra requisição já
       tiver vinculado um cartão, esta atualização não encontra a linha, e o
       cartão desta chamada fica órfão em Demandas em vez de quebrar algo. */
    await d1.batch([
      demand.statement,
      d1.prepare(`UPDATE fdp_work_accidents SET investigation_card_id = ?, updated_by = ?, updated_at = now()
          WHERE workspace_id = ? AND id = ? AND investigation_card_id IS NULL`)
        .bind(demand.cardId, user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "work_accident.investigation_opened", entityType: "work_accident", entityId: id,
        after: { investigationCardId: demand.cardId, title: demand.title },
        metadata: { scope: "company", companyId: accident.company_id, areaId: demand.area.id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ cardId: demand.cardId, title: demand.title }, { status: 201 });
  } catch (error) { return apiError(error); }
}
