import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, prepareAuditEvent, prepareActivity, requireCompanyAccess,
} from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { prepareAdoptionIncrement } from "@/lib/adoption-metrics";
import { deriveIdempotencyKey } from "@/lib/domain-events";
import {
  findEventByIdempotencyKey, isIdempotencyConflict, prepareDomainEventEnvelope,
} from "@/lib/outbox";
import { loadPublishedVersion, prepareProcessInstance } from "@/lib/process-instances";
import { requireProcessCompanyAccess } from "@/lib/process-access";
import { validCompetence } from "@/lib/operations";
import { cleanText } from "@/lib/registrations";

/**
 * Instanciar uma versão publicada (§12).
 *
 * Este é o elo que a auditoria apontou como inexistente: até aqui, publicar um
 * processo trocava um `status` e nada acontecia. Agora uma versão publicada
 * produz demanda — com a etapa inicial que o próprio desenho define, o checklist
 * que a etapa exige e o prazo que a versão configurou.
 *
 * A demanda nasce **presa à versão** (`process_version_id`). Publicar a versão
 * seguinte não a alcança: ela termina pela regra sob a qual começou.
 *
 * Idempotência: com `idempotencyKey`, a segunda chamada não abre uma segunda
 * demanda. Quem garante isso é o índice único sobre o evento de domínio gravado
 * no mesmo lote — a violação aborta a transação inteira, e a resposta passa a
 * ser a demanda que já existia. Uma verificação em código seria atravessada por
 * duas requisições simultâneas.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.read", "iniciar um processo");
    requireNamedCapability(workspace, "cards.write", "abrir uma demanda");

    const version = await loadPublishedVersion(d1, workspace.id, id);
    await requireProcessCompanyAccess(d1, workspace.id, user.id, workspace.role, version.definitionId, version.isCorporate);

    const companyId = text(body.companyId, 120) || null;
    let companyName = "";
    if (companyId) {
      const company = await d1.prepare(
        "SELECT legal_name, trade_name FROM fdp_companies WHERE workspace_id = ? AND id = ? AND status = 'active'",
      ).bind(workspace.id, companyId).first<{ legal_name: string; trade_name: string }>();
      if (!company) throw ApiError.badRequest("Empresa selecionada não encontrada.", "COMPANY_NOT_FOUND");
      companyName = company.trade_name || company.legal_name;
      await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    }

    const requestedBoardId = text(body.boardId, 100);
    let targetBoardId = board.id;
    if (requestedBoardId && requestedBoardId !== board.id) {
      const requested = await d1.prepare("SELECT id FROM fdp_boards WHERE workspace_id = ? AND id = ?")
        .bind(workspace.id, requestedBoardId).first<{ id: string }>();
      if (!requested) throw ApiError.badRequest("Quadro selecionado não encontrado.", "BOARD_NOT_FOUND");
      targetBoardId = String(requested.id);
    }
    const list = await d1.prepare(`SELECT id, sla_behavior FROM fdp_lists
      WHERE board_id = ? ORDER BY (kind = 'new') DESC, position, id LIMIT 1`)
      .bind(targetBoardId).first<{ id: string; sla_behavior: string }>();
    if (!list) {
      throw ApiError.notFound("Este quadro não tem nenhuma coluna. Crie uma coluna antes de iniciar processos.", "LIST_NOT_FOUND");
    }

    const externalId = cleanText(body.externalId, 300);
    const idempotencyKey = cleanText(body.idempotencyKey, 64) || (externalId
      ? deriveIdempotencyKey({
        workspaceId: workspace.id, name: "process.instance_started", origin: "internal",
        externalId: `${version.versionId}:${externalId}`,
      })
      : "");

    if (idempotencyKey) {
      const existing = await findEventByIdempotencyKey(d1, workspace.id, idempotencyKey);
      if (existing?.entity_id) {
        return Response.json({ instance: { cardId: existing.entity_id }, duplicate: true }, { status: 200 });
      }
    }

    const globalSlaMinutes = 0;
    const { statements, result } = await prepareProcessInstance(d1, {
      workspaceId: workspace.id,
      version,
      actor: { userId: user.id, email: auth.user.email },
      boardId: targetBoardId,
      listId: String(list.id),
      listSlaBehavior: String(list.sla_behavior ?? ""),
      title: text(body.title, 180),
      description: text(body.description, 4000),
      companyId,
      companyName,
      competence: body.competence ? validCompetence(body.competence) : "",
      priority: text(body.priority, 20),
      sourceType: "process",
      globalSlaMinutes,
      trigger: cleanText(body.trigger, 80) || "manual",
      idempotencyKey,
      requestId: request.headers.get("x-fila-dp-request-id"),
    });

    try {
      await d1.batch([
        ...statements,
        prepareActivity(workspace.id, result.cardId, auth.user.email, "process.instance_started", {
          processId: version.definitionId, versionId: version.versionId,
          versionNumber: result.versionNumber, stepId: result.stepId, stepLabel: result.stepLabel,
        }),
        prepareDomainEventEnvelope(d1, {
          name: "process.instance_started",
          origin: "internal",
          workspaceId: workspace.id,
          entityId: result.cardId,
          externalId,
          idempotencyKey: idempotencyKey || undefined,
          correlationId: cleanText(body.correlationId, 120) || undefined,
          causationId: cleanText(body.causationId, 120) || undefined,
          payload: {
            processDefinitionId: version.definitionId,
            processVersionId: version.versionId,
            processVersionNumber: result.versionNumber,
            currentStepId: result.stepId,
            cardId: result.cardId,
            companyId: companyId ?? "",
            trigger: cleanText(body.trigger, 80) || "manual",
          },
        }, {
          actorUserId: user.id,
          requestId: request.headers.get("x-fila-dp-request-id"),
          onConflict: idempotencyKey ? "raise" : "ignore",
        }),
        prepareAdoptionIncrement(d1, workspace.id, "demands_from_process"),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "process.instance_started", entityType: "card", entityId: result.cardId,
          after: {
            processDefinitionId: version.definitionId, processVersionId: version.versionId,
            processVersionNumber: result.versionNumber, currentStepId: result.stepId,
          },
          requestId: request.headers.get("x-fila-dp-request-id"),
        }),
      ]);
    } catch (error) {
      if (idempotencyKey && isIdempotencyConflict(error)) {
        // Outra entrega da mesma ocorrência venceu a corrida. A transação desta
        // foi desfeita inteira, então não existe demanda órfã para limpar.
        const existing = await findEventByIdempotencyKey(d1, workspace.id, idempotencyKey);
        if (existing?.entity_id) {
          return Response.json({ instance: { cardId: existing.entity_id }, duplicate: true }, { status: 200 });
        }
      }
      throw error;
    }

    return Response.json({
      instance: {
        cardId: result.cardId,
        processId: version.definitionId,
        processName: version.definitionName,
        versionId: version.versionId,
        versionNumber: result.versionNumber,
        currentStepId: result.stepId,
        currentStepLabel: result.stepLabel,
        dueAt: result.dueAt,
        checklist: result.checklist,
      },
      duplicate: false,
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
