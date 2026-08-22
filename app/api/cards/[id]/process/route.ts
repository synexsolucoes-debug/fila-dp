import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, prepareActivity, prepareAuditEvent, requireCompanyAccess,
} from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
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
    instance: {
      cardId: instance.id,
      processId: instance.processDefinitionId,
      processName: version.definitionName,
      versionId: instance.processVersionId,
      versionNumber: instance.processVersionNumber,
      currentStepId: instance.currentStepId,
      currentStepLabel: stepLabel(version.graph, instance.currentStepId),
      terminal: isTerminalStep(version.graph, instance.currentStepId),
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
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "process.step_advanced", entityType: "card", entityId: instance.id,
        before: { currentStepId: fromStepId, version: instance.version },
        after: { currentStepId: evaluation.targetStepId, version: instance.version + 1 },
        metadata: { processVersionId: instance.processVersionId, note: cleanText(body.note, 500) },
        requestId: context.requestId,
      }),
    ]);

    const after = await loadContext(request, id);
    if ("response" in after) return after.response;
    return Response.json({ ...payload(after), applied: true, duplicate: false });
  } catch (error) {
    return apiError(error);
  }
}
