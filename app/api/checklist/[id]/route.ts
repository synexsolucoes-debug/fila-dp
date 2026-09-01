import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireWorkspaceRole, runAutomations } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { blockedTasks, taskCompletionBlocker, taskOf } from "@/lib/process-tasks";
import { prepareStepAutomations } from "@/lib/process-automations";
import { loadPublishedVersion } from "@/lib/process-instances";
import { prepareDomainEventEnvelope } from "@/lib/outbox";
import { stepLabel } from "@/lib/bpmn-graph";
import { log } from "@/lib/observability";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Marcar e desmarcar uma tarefa da demanda (§41, §42).
 *
 * Até a migration 0072 esta rota era um `UPDATE` de uma coluna: qualquer item
 * podia ser marcado, em qualquer ordem, sem prova nenhuma. Com a tarefa virando
 * entidade, três coisas passam a ser conferidas **aqui**, e não na tela:
 *
 * 1. **Dependência** — "Conferir CPF" não é marcada antes de "Receber
 *    documentos". A tela desabilita o item, mas a tela é uma fotografia; a
 *    ordem só é uma garantia se o servidor recusar.
 * 2. **Regra de conclusão** — `evidence` e `document` exigem anexo *na própria
 *    tarefa*. Era a distinção que faltava: um comprovante enviado em outra
 *    etapa satisfazia a exigência escrita nesta (§43).
 * 3. **Quem concluiu** — `completed_by` é o registro que falta justamente
 *    quando alguém pergunta, meses depois, quem deu aquilo por feito (§79).
 *
 * Desmarcar não confere dependência de propósito: quem errou precisa poder
 * corrigir, e o dependente continua barrado pela regra 1 enquanto isto estiver
 * aberto. Desmarcar limpa `completed_by` junto — deixar o nome anterior ali
 * seria afirmar uma conclusão que já não existe.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { completed?: boolean };
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");
    const item = await d1.prepare(`SELECT ci.id, ci.card_id, ci.title, ci.completed
      FROM fdp_checklist_items ci JOIN fdp_cards c ON c.id = ci.card_id
      WHERE ci.id = ? AND c.board_id = ? AND c.archived = 0`)
      .bind(id, board.id)
      .first<{ id: string; card_id: string; title: string; completed: number }>();
    if (!item) throw ApiError.notFound("Etapa não encontrada.", "CHECKLIST_ITEM_NOT_FOUND");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, item.card_id);
    const completed = Boolean(body.completed);

    if (completed) {
      /* As tarefas da demanda com os anexos de cada uma.
         A contagem e os nomes vêm por subconsulta correlacionada e não por
         `JOIN`: com `JOIN`, uma tarefa com três anexos apareceria três vezes e
         a dependência seria avaliada sobre linhas repetidas. */
      const rows = await d1.prepare(`SELECT ci.*,
          (SELECT count(*)::int FROM fdp_card_attachments a
            WHERE a.workspace_id = ci.workspace_id AND a.checklist_item_id = ci.id) AS attachment_count,
          COALESCE((SELECT array_agg(a.filename) FROM fdp_card_attachments a
            WHERE a.workspace_id = ci.workspace_id AND a.checklist_item_id = ci.id), '{}') AS attachment_names
        FROM fdp_checklist_items ci
        WHERE ci.workspace_id = ? AND ci.card_id = ?
        ORDER BY ci.position`)
        .bind(workspace.id, item.card_id).all<Record<string, unknown>>();

      const tasks = rows.results.map(taskOf);
      const target = tasks.find((task) => task.id === id);
      if (target) {
        const blocker = taskCompletionBlocker(target, blockedTasks(tasks));
        if (blocker) throw new ApiError(422, blocker.code, blocker.reason);
      }
    }

    /* A mudança é condicional ao estado observado. Duas requisições iguais em
       paralelo não disparam duas automações nem duplicam o histórico: somente a
       conexão que realmente altera a tarefa continua para os efeitos colaterais. */
    const changed = await d1.prepare(`UPDATE fdp_checklist_items
        SET completed = ?,
            completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
            completed_by = CASE WHEN ? = 1 THEN ? ELSE '' END
      WHERE workspace_id = ? AND id = ? AND completed IS DISTINCT FROM ?`)
      .bind(completed ? 1 : 0, completed ? 1 : 0, completed ? 1 : 0, completed ? auth.user.email : "", workspace.id, id, completed ? 1 : 0)
      .run();
    if (Number(changed.meta?.changes ?? 0) === 0) {
      return Response.json(await getWorkspaceSnapshot(auth.user));
    }

    const remaining = await d1.prepare("SELECT COUNT(*) AS count FROM fdp_checklist_items WHERE card_id = ? AND completed = 0").bind(item.card_id).first<{ count: number }>();
    if (Number(remaining?.count ?? 0) === 0) await runAutomations(workspace.id, board.id, item.card_id, "checklist.completed", auth.user.email, { allItems: true });

    /* "Todas obrigatórias concluídas → liberar avanço" (§27).
       O avanço já estava liberado pela ausência de bloqueio — é o motor que
       decide isso. O que faltava era o **aviso**: a etapa fica pronta e ninguém
       sabe, porque quem marca a última tarefa costuma não ser quem avança.

       Só quando a demanda tem processo, e só quando a última bloqueante caiu:
       consultar a versão a cada item marcado num quadro sem processo seria
       consulta paga por quem não usa a função. */
    if (completed) await releaseWhenStepIsDone({
      d1, workspaceId: workspace.id, cardId: item.card_id, actorEmail: auth.user.email, userId: user.id,
    });
    await recordActivity(workspace.id, item.card_id, auth.user.email, "checklist.item_toggled", { itemId: id, title: item.title, fromCompleted: Boolean(item.completed), completed });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Dispara as automações de "todas as obrigatórias concluídas" (§27).
 *
 * Roda fora da transação da marcação, e nunca derruba a resposta: a tarefa
 * **foi** concluída, que é o que a pessoa pediu; a automação é o efeito
 * colateral. Uma falha aqui que devolvesse 500 faria a pessoa remarcar um item
 * que já está marcado.
 */
async function releaseWhenStepIsDone(input: {
  d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"];
  workspaceId: string; cardId: string; actorEmail: string; userId: string;
}) {
  const { d1, workspaceId, cardId } = input;
  try {
    const card = await d1.prepare(
      "SELECT process_version_id, current_step_id FROM fdp_cards WHERE workspace_id = ? AND id = ?",
    ).bind(workspaceId, cardId).first<{ process_version_id: string; current_step_id: string }>();
    const versionId = String(card?.process_version_id ?? "");
    const stepId = String(card?.current_step_id ?? "");
    if (!versionId || !stepId) return;

    const pending = await d1.prepare(`SELECT COUNT(*)::int AS count FROM fdp_checklist_items
        WHERE workspace_id = ? AND card_id = ? AND completed = 0
          AND required = 1 AND blocks_advance = 1
          AND (process_step_id = ? OR process_step_id = '')`)
      .bind(workspaceId, cardId, stepId).first<{ count: number }>();
    if (Number(pending?.count ?? 0) > 0) return;

    const version = await loadPublishedVersion(d1, workspaceId, versionId);
    const config = version.steps.get(stepId) ?? null;
    if (!config?.automations.length) return;

    const { statements, events } = prepareStepAutomations(d1, {
      rules: config.automations, trigger: "all_required_done",
      context: {
        workspaceId, cardId, stepId, stepLabel: stepLabel(version.graph, stepId),
        fallbackAreaId: config.responsibleDepartmentId || config.departmentId || null,
        processDefinitionId: version.definitionId, processVersionId: version.versionId,
      },
    });
    if (!statements.length && !events.length) return;
    await d1.batch([
      ...statements,
      ...events.map((event) => prepareDomainEventEnvelope(d1, {
        name: event.name, origin: "internal", workspaceId, entityId: cardId, payload: event.payload,
      }, { actorUserId: input.userId })),
    ]);
    await recordActivity(workspaceId, cardId, input.actorEmail, "process.step_ready", {
      stepId, stepLabel: stepLabel(version.graph, stepId),
    });
  } catch (error) {
    log("warn", "process.automation_release_failed", { workspaceId }, {
      cardId, reason: error instanceof Error ? error.message : String(error),
    });
  }
}
