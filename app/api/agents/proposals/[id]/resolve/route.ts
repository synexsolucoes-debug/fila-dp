import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, prepareActivity, prepareAuditEvent, requireCompanyAccess,
} from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { isSensitiveAction } from "@/lib/agent-proposals";
import { prepareDomainEventEnvelope } from "@/lib/outbox";
import {
  evaluateTransition, loadProcessInstance, loadPublishedVersion, prepareTransitionStatement,
  resolveStepDeadline, stepChecklist, type TransitionActor,
} from "@/lib/process-instances";
import { cleanText } from "@/lib/registrations";

/**
 * Resolver uma proposta de agente (§16, §17, §19).
 *
 * Aqui fecha a cadeia obrigatória: a proposta que o motor determinístico
 * aprovou (ou que uma pessoa confirmou na triagem) chega ao **serviço de
 * domínio**, que reavalia tudo do zero — versão, etapa, destino autorizado,
 * checklist, evidência, responsável, aprovador e concorrência.
 *
 * O ponto que importa: o agente não ganha um caminho mais curto. A transição
 * que ele propõe passa exatamente pelas mesmas recusas que a de uma pessoa, e
 * o ator avaliado é quem chamou esta rota — nunca um ator sintético que
 * atravessaria as regras de responsabilidade e aprovação.
 *
 * Ação sensível nunca é aplicada por aqui, mesmo confirmada: §18 é explícito, e
 * salário, desligamento, aprovação e escrita em ERP têm caminho próprio, com
 * suas próprias regras.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.reconcile", "resolver uma proposta de agente");

    const action = text(body.action, 20);
    if (!["apply", "reject", "discard"].includes(action)) {
      throw ApiError.badRequest("Informe se a proposta será aplicada, recusada ou descartada.", "AGENT_RESOLUTION_INVALID");
    }
    const note = cleanText(body.note, 500);
    const requestId = request.headers.get("x-fila-dp-request-id");

    const proposal = await d1.prepare("SELECT * FROM fdp_agent_proposals WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!proposal) throw ApiError.notFound("Proposta não encontrada.", "AGENT_PROPOSAL_NOT_FOUND");
    const status = String(proposal.status);
    if (!["pending_triage", "suggested", "accepted"].includes(status)) {
      throw new ApiError(409, "AGENT_PROPOSAL_ALREADY_RESOLVED",
        "Esta proposta já foi resolvida. Recarregue para ver o estado atual.");
    }

    if (action !== "apply") {
      const finalStatus = action === "reject" ? "rejected" : "discarded";
      await d1.batch([
        d1.prepare(`UPDATE fdp_agent_proposals
            SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
                resolution_note = ?, updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = ? AND id = ? AND status IN ('pending_triage', 'suggested', 'accepted')`)
          .bind(finalStatus, user.id, note, workspace.id, id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "agent.proposal_resolved", entityType: "agent_proposal", entityId: id,
          before: { status }, after: { status: finalStatus, note },
          requestId,
        }),
      ]);
      return Response.json({ proposal: { id, status: finalStatus }, applied: false });
    }

    const proposedAction = String(proposal.proposed_action);
    if (isSensitiveAction(proposedAction)) {
      throw ApiError.forbidden(
        "Ação sensível não é aplicada a partir de uma proposta de agente. Use o fluxo próprio, que registra decisão e aprovador.",
        "AGENT_SENSITIVE_ACTION",
      );
    }
    if (proposedAction !== "process.advance") {
      throw ApiError.badRequest(
        `A aplicação automática ainda cobre apenas o avanço de etapa. A ação "${proposedAction}" precisa ser executada na tela do módulo correspondente.`,
        "AGENT_ACTION_NOT_APPLICABLE",
      );
    }
    requireNamedCapability(workspace, "cards.write", "avançar a etapa da demanda");

    const cardId = String(proposal.process_instance_id ?? "");
    if (!cardId) throw ApiError.badRequest("A proposta não aponta uma demanda.", "AGENT_INSTANCE_REQUIRED");

    const instance = await loadProcessInstance(d1, workspace.id, cardId);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, instance.companyId);
    const version = await loadPublishedVersion(d1, workspace.id, instance.processVersionId);

    const [areas, checklistRow, attachments] = await Promise.all([
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

    const targetStepId = String(proposal.proposed_step_id ?? "");
    const evaluation = evaluateTransition({
      version, instance, targetStepId, actor,
      pendingChecklist: Number(checklistRow?.pending ?? 0),
      attachmentCount: Number(attachments?.total ?? 0),
    });
    if (!evaluation.allowed) {
      const [first] = evaluation.blockers;
      throw new ApiError(422, first?.code ?? "PROCESS_TRANSITION_NOT_ALLOWED",
        first?.message ?? "Esta transição não é permitida.", { blockers: evaluation.blockers });
    }

    const nextConfig = version.steps.get(evaluation.targetStepId) ?? null;
    const dueAt = await resolveStepDeadline(d1, workspace.id, nextConfig, 0);
    const applied = await prepareTransitionStatement(d1, {
      workspaceId: workspace.id, cardId, fromStepId: instance.currentStepId,
      toStepId: evaluation.targetStepId, expectedVersion: instance.version,
      terminal: evaluation.terminal, dueAt,
    }).first<{ id: string }>();
    if (!applied) {
      throw new ApiError(409, "CARD_VERSION_CONFLICT",
        "Esta demanda foi alterada por outra pessoa. Recarregue para ver o estado atual antes de aplicar.");
    }

    await d1.batch([
      ...stepChecklist(nextConfig).map((item, index) => d1.prepare(
        "INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position, process_step_id) VALUES (?, ?, ?, ?, 0, ?, ?)",
      ).bind(crypto.randomUUID(), workspace.id, cardId, item, (index + 1) * 1000, evaluation.targetStepId)),
      d1.prepare(`UPDATE fdp_agent_proposals
          SET status = 'applied', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
              resolution_note = ?, result_type = 'card', result_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ?`)
        .bind(user.id, note, cardId, workspace.id, id),
      prepareActivity(workspace.id, cardId, auth.user.email, "process.step_advanced", {
        fromStepId: instance.currentStepId, toStepId: evaluation.targetStepId,
        toStepLabel: evaluation.targetLabel, proposalId: id, agentKey: String(proposal.agent_key),
      }),
      prepareDomainEventEnvelope(d1, {
        name: evaluation.terminal ? "process.instance_completed" : "process.step_advanced",
        origin: "agent",
        workspaceId: workspace.id,
        entityId: cardId,
        causationId: id,
        payload: {
          cardId,
          processDefinitionId: instance.processDefinitionId,
          processVersionId: instance.processVersionId,
          processVersionNumber: instance.processVersionNumber,
          fromStepId: instance.currentStepId,
          currentStepId: evaluation.targetStepId,
          companyId: instance.companyId ?? "",
        },
      }, { actorUserId: user.id, requestId }),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "agent.proposal_applied", entityType: "agent_proposal", entityId: id,
        before: { status, currentStepId: instance.currentStepId },
        after: { status: "applied", cardId, currentStepId: evaluation.targetStepId },
        metadata: { agentKey: String(proposal.agent_key), decisionCode: String(proposal.decision_code) },
        requestId,
      }),
    ]);

    return Response.json({
      proposal: { id, status: "applied" },
      applied: true,
      instance: { cardId, currentStepId: evaluation.targetStepId, currentStepLabel: evaluation.targetLabel },
    });
  } catch (error) {
    return apiError(error);
  }
}
