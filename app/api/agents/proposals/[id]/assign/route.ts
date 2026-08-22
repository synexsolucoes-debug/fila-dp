import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";

/**
 * Encaminhar uma triagem para quem sabe resolvê-la (§16).
 *
 * Encaminhar **não** é resolver: o item continua na mesma fila, com o mesmo
 * estado e o mesmo ciclo de vida. O que muda é de quem a operação espera a
 * decisão — e é por isso que isto não virou uma fila de encaminhamento ao lado,
 * com tela própria e estado próprio para sincronizar (§1).
 *
 * Só item ainda em aberto é encaminhável. Encaminhar o que já foi decidido
 * criaria a impressão de que alguém ainda precisa agir, e a pessoa abriria o
 * item para descobrir que não havia o que fazer.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "integrations.reconcile", "encaminhar uma triagem");

    const assignee = text(body.assigneeId, 80);
    const note = cleanText(body.note, 500);

    const proposal = await d1.prepare(`SELECT id, status, assigned_to FROM fdp_agent_proposals
        WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<{ id: string; status: string; assigned_to: string | null }>();
    if (!proposal) throw ApiError.notFound("Item de triagem não encontrado.", "AGENT_PROPOSAL_NOT_FOUND");
    if (!["pending_triage", "suggested"].includes(proposal.status)) {
      throw new ApiError(409, "AGENT_PROPOSAL_ALREADY_RESOLVED",
        "Este item já foi resolvido e não precisa mais de responsável.");
    }

    /* A chave composta com `fdp_workspace_members` já impede encaminhar para
       alguém de outro grupo; a conferência aqui existe para a recusa chegar
       como frase, e não como violação de chave estrangeira. */
    if (assignee) {
      const member = await d1.prepare(`SELECT u.name FROM fdp_workspace_members m
          JOIN fdp_users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.user_id = ?`)
        .bind(workspace.id, assignee).first<{ name: string }>();
      if (!member) {
        throw ApiError.badRequest("Escolha alguém que tenha acesso a este grupo.", "TRIAGE_ASSIGNEE_INVALID");
      }
    }

    await d1.batch([
      d1.prepare(`UPDATE fdp_agent_proposals
          SET assigned_to = ?, assigned_at = CASE WHEN ?::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
              assignment_note = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ? AND status IN ('pending_triage', 'suggested')`)
        .bind(assignee || null, assignee || null, note, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: assignee ? "triage.assigned" : "triage.unassigned",
        entityType: "agent_proposal", entityId: id,
        before: { assignedTo: proposal.assigned_to },
        after: { assignedTo: assignee || null, note },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ proposal: { id, assignedTo: assignee || null, note } });
  } catch (error) {
    return apiError(error);
  }
}
