import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, prepareActivity, prepareAuditEvent, requireCompanyAccess, runAutomations,
} from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { prepareAdoptionIncrement } from "@/lib/adoption-metrics";
import { prepareDomainEventEnvelope } from "@/lib/outbox";
import {
  availableTransitions, evaluateTransition, loadProcessInstance, loadPublishedVersion,
  prepareTransitionStatement, resolveStepDeadline, stepChecklist,
  type TransitionActor,
} from "@/lib/process-instances";
import { isTerminalStep, stepLabel } from "@/lib/bpmn-graph";
import { cleanText } from "@/lib/registrations";

/**
 * Etapa da demanda: consultar destinos e avançar (§15).
 *
 * A regra que esta rota existe para impor é uma só: **a etapa não muda por
 * `UPDATE` direto**. O frontend não decide para onde a demanda vai; ele pergunta
 * aqui quais destinos o desenho autoriza, e recebe junto o motivo de cada
 * bloqueio — que é o que permite desabilitar o botão dizendo o que resolve, em
 * vez de recusar depois do clique com uma mensagem genérica.
 *
 * O avanço é reavaliado do zero no servidor. O que a tela mostrou é uma
 * fotografia; entre a fotografia e o clique alguém pode ter desmarcado um item
 * de checklist.
 */

type RouteContext = { params: Promise<{ id: string }> };

type Loaded = Awaited<ReturnType<typeof loadContext>>;

async function loadContext(request: Request, cardId: string) {
  const auth = await getApiUser();
  if (!auth.user) return { response: auth.response } as const;
  const { d1, workspace, user } = await getWorkspaceContext(auth.user);
  requireNamedCapability(workspace, "cards.read", "consultar a etapa da demanda");

  const instance = await loadProcessInstance(d1, workspace.id, cardId);
  await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, instance.companyId);
  const version = await loadPublishedVersion(d1, workspace.id, instance.processVersionId);

  const [areas, checklist, attachments] = await Promise.all([
    d1.prepare("SELECT area_id FROM fdp_area_members WHERE workspace_id = ? AND user_id = ?")
      .bind(workspace.id, user.id).all<{ area_id: string }>(),
    d1.prepare(`SELECT COUNT(*)::int AS pending FROM fdp_checklist_items
        WHERE workspace_id = ? AND card_id = ? AND completed = 0
          AND (process_step_id = ? OR process_step_id = '')`)
      .bind(workspace.id, cardId, instance.currentStepId).first<{ pending: number }>(),
    d1.prepare("SELECT COUNT(*)::int AS total FROM fdp_card_attachments WHERE workspace_id = ? AND card_id = ?")
      .bind(workspace.id, cardId).first<{ total: number }>(),
  ]);

  const actor: TransitionActor = {
    userId: user.id,
    email: auth.user.email,
    role: workspace.role,
    canDecideApprovals: hasCapability(workspace, "approvals.decide"),
    areaIds: new Set(areas.results.map((row) => String(row.area_id))),
  };

  return {
    auth, d1, workspace, user, instance, version, actor,
    pendingChecklist: Number(checklist?.pending ?? 0),
    attachmentCount: Number(attachments?.total ?? 0),
    requestId: request.headers.get("x-fila-dp-request-id"),
  } as const;
}

function payload(context: Extract<Loaded, { instance: unknown }>) {
  const { version, instance } = context;
  return {
    linked: true,
    instance: {
      cardId: instance.id,
      processId: instance.processDefinitionId,
      processName: version.definitionName,
      versionId: instance.processVersionId,
      versionNumber: instance.processVersionNumber,
      currentStepId: instance.currentStepId,
      currentStepLabel: stepLabel(version.graph, instance.currentStepId),
      terminal: isTerminalStep(version.graph, instance.currentStepId),
      /* Se a etapa exige aval, quem avança está APROVANDO — e a tela precisa
         dizer isso antes do clique, não depois. O motor já decide com
         `requiresApproval` desde sempre; o que faltava era a tela saber, para
         parar de chamar de "avançar" um ato que tem responsável e consequência.

         Vem da configuração já carregada em `version.steps`: sem consulta nova. */
      requiresApproval: Boolean(version.steps.get(instance.currentStepId)?.requiresApproval),
      version: instance.version,
    },
    transitions: availableTransitions({
      version, instance, actor: context.actor,
      pendingChecklist: context.pendingChecklist,
      attachmentCount: context.attachmentCount,
    }),
  };
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const context = await loadContext(request, id);
    if ("response" in context) return context.response;
    return Response.json(payload(context));
  } catch (error) {
    /* "Em que etapa esta demanda está?" tem resposta mesmo quando a demanda não
       nasceu de processo: **nenhuma**. Responder 400 a uma pergunta legítima
       transformava o caso mais comum do produto — toda demanda anterior à
       consolidação e toda demanda aberta à mão — em erro de rede no console, e
       um console cheio de erro esperado é um console onde ninguém enxerga o
       erro de verdade. Foi assim que esta rota apareceu na verificação de
       navegador. Ler continua respondendo; **avançar** (`POST`) continua
       recusando, porque aí não há etapa para onde ir. */
    if (error instanceof ApiError && error.code === "CARD_WITHOUT_PROCESS") {
      return Response.json({ linked: false, reason: error.code, message: error.message, transitions: [] });
    }
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const context = await loadContext(request, id);
    if ("response" in context) return context.response;
    const { d1, workspace, user, instance, version, auth } = context;
    requireNamedCapability(workspace, "cards.write", "avançar a etapa da demanda");

    const targetStepId = text(body.targetStepId, 160);
    const fromStepId = instance.currentStepId;

    // Repetição da mesma transição é sucesso, não conflito: quem reenviou quer
    // exatamente o estado em que a demanda já está.
    if (targetStepId && targetStepId === fromStepId) {
      return Response.json({ ...payload(context), applied: false, duplicate: true });
    }

    const evaluation = evaluateTransition({
      version, instance, targetStepId, actor: context.actor,
      pendingChecklist: context.pendingChecklist,
      attachmentCount: context.attachmentCount,
    });
    if (!evaluation.allowed) {
      const [first] = evaluation.blockers;
      throw new ApiError(422, first?.code ?? "PROCESS_TRANSITION_NOT_ALLOWED",
        first?.message ?? "Esta transição não é permitida.",
        { blockers: evaluation.blockers });
    }

    const nextConfig = version.steps.get(evaluation.targetStepId) ?? null;
    const dueAt = await resolveStepDeadline(d1, workspace.id, nextConfig, 0);
    const checklist = stepChecklist(nextConfig);

    /* A troca de etapa acontece sozinha e antes de tudo, com `RETURNING`.
       Isso é deliberado: se ela não pegar — porque outra pessoa moveu a demanda
       entre a leitura e a escrita — nada mais é gravado, e a resposta é 409 sem
       ter registrado uma transição que não aconteceu. O caminho inverso (gravar
       o evento junto e conferir depois) deixaria auditoria afirmando um avanço
       inexistente, que é o pior dos dois erros possíveis aqui. */
    const applied = await prepareTransitionStatement(d1, {
      workspaceId: workspace.id, cardId: instance.id,
      fromStepId, toStepId: evaluation.targetStepId,
      expectedVersion: instance.version, terminal: evaluation.terminal, dueAt,
    }).first<{ id: string; version: number }>();
    if (!applied) {
      throw new ApiError(409, "CARD_VERSION_CONFLICT",
        "Esta demanda foi alterada por outra pessoa. Recarregue para ver o estado atual antes de avançar.");
    }

    const eventName = evaluation.terminal ? "process.instance_completed" : "process.step_advanced";
    await d1.batch([
      ...checklist.map((item, index) => d1.prepare(
        "INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position, process_step_id) VALUES (?, ?, ?, ?, 0, ?, ?)",
      ).bind(
        crypto.randomUUID(), workspace.id, instance.id, item,
        (index + 1) * 1000, evaluation.targetStepId,
      )),
      prepareActivity(workspace.id, instance.id, auth.user.email, "process.step_advanced", {
        fromStepId, toStepId: evaluation.targetStepId, toStepLabel: evaluation.targetLabel,
        versionId: instance.processVersionId, versionNumber: instance.processVersionNumber,
      }),
      prepareDomainEventEnvelope(d1, {
        name: eventName,
        origin: "internal",
        workspaceId: workspace.id,
        entityId: instance.id,
        payload: {
          cardId: instance.id,
          processDefinitionId: instance.processDefinitionId,
          processVersionId: instance.processVersionId,
          processVersionNumber: instance.processVersionNumber,
          fromStepId, currentStepId: evaluation.targetStepId,
          companyId: instance.companyId ?? "",
        },
      }, { actorUserId: user.id, requestId: context.requestId }),
      prepareAdoptionIncrement(d1, workspace.id,
        evaluation.terminal ? "process_instances_completed" : "process_steps_advanced"),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "process.step_advanced", entityType: "card", entityId: instance.id,
        before: { currentStepId: fromStepId, version: instance.version },
        after: { currentStepId: evaluation.targetStepId, version: instance.version + 1 },
        metadata: { processVersionId: instance.processVersionId, note: cleanText(body.note, 500) },
        requestId: context.requestId,
      }),
    ]);

    /* Automação do quadro reagindo ao processo (§27).
       O §27 pede "etapa Documentação concluída → iniciar Registro" e "etapa
       Integrações iniciada → criar tarefa TI". O motor de regras existia e
       nenhum evento de processo o alcançava: mover etapa mudava a demanda sem
       que nenhuma regra soubesse.

       Roda **depois** do lote, e não dentro dele: a transição precisa estar
       gravada antes de qualquer regra reagir a ela — uma regra que rodasse
       junto poderia mover a demanda a partir de um estado que ainda não vale.
       Se a automação falhar, a etapa já avançou, que é o efeito que a pessoa
       pediu; a regra é o efeito colateral. */
    await runAutomations(workspace.id, instance.boardId, instance.id, eventName, auth.user.email, {
      toStepId: evaluation.targetStepId,
      fromStepId,
      processId: instance.processDefinitionId,
      terminal: evaluation.terminal ? "yes" : "no",
    });

    const after = await loadContext(request, id);
    if ("response" in after) return after.response;
    return Response.json({ ...payload(after), applied: true, duplicate: false });
  } catch (error) {
    return apiError(error);
  }
}
