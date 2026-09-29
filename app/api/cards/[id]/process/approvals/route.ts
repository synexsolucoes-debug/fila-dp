import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import {
  approverEligibility, countStepApprovals, loadProcessInstance, loadPublishedVersion,
  prepareStepApproval, type TransitionActor,
} from "@/lib/process-instances";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Registra a aprovação de uma pessoa para a etapa atual da demanda (§3.11).
 *
 * Existe só para `approvalCount > 1`: quando a etapa pede uma aprovação só,
 * quem avança em `POST /api/cards/[id]/process` já é o aprovador — sempre foi
 * assim, e continua sendo, sem passar por aqui. Esta rota é o segundo (e
 * terceiro, ...) aprovador registrando a própria decisão sem mexer na etapa
 * em si; só depois que a contagem bate com `approvalCount` é que a rota de
 * avançar deixa de recusar.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id: cardId } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "cards.write", "aprovar a etapa da demanda");

    const instance = await loadProcessInstance(d1, workspace.id, cardId);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, instance.companyId);
    const version = await loadPublishedVersion(d1, workspace.id, instance.processVersionId);
    const config = version.steps.get(instance.currentStepId) ?? null;
    if (!config?.requiresApproval) {
      throw ApiError.badRequest("Esta etapa não exige aprovação.", "PROCESS_STEP_APPROVAL_NOT_REQUIRED");
    }
    if (config.approvalCount <= 1) {
      throw ApiError.badRequest(
        "Esta etapa exige um só aprovador — avance a etapa para aprovar.",
        "PROCESS_STEP_APPROVAL_SINGLE",
      );
    }

    const areas = await d1.prepare("SELECT area_id FROM fdp_area_members WHERE workspace_id = ? AND user_id = ?")
      .bind(workspace.id, user.id).all<{ area_id: string }>();
    const actor: TransitionActor = {
      userId: user.id,
      email: auth.user.email,
      role: workspace.role,
      canDecideApprovals: hasCapability(workspace, "approvals.decide"),
      areaIds: new Set(areas.results.map((row) => String(row.area_id))),
    };
    const { eligible, selfApproval } = approverEligibility(config, actor, instance.createdBy);
    if (!eligible) {
      throw new ApiError(403, "PROCESS_STEP_APPROVAL_REQUIRED", "Esta etapa exige aprovação e você não é aprovador dela.");
    }
    if (selfApproval) {
      throw new ApiError(403, "PROCESS_STEP_SELF_APPROVAL", "Quem abriu a demanda não pode aprovar a própria etapa.");
    }

    await d1.batch([
      prepareStepApproval(d1, {
        workspaceId: workspace.id, cardId, processVersionId: instance.processVersionId,
        bpmnElementId: instance.currentStepId, approverUserId: user.id,
      }),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "process.step_approved", entityType: "demand", entityId: cardId,
        after: { bpmnElementId: instance.currentStepId, processVersionId: instance.processVersionId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    const approvalsCount = await countStepApprovals(d1, workspace.id, cardId, instance.currentStepId);
    return Response.json({
      approvalsCount, approvalCount: config.approvalCount,
      thresholdReached: approvalsCount >= config.approvalCount,
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
