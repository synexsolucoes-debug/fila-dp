import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";

/**
 * Aprovação do lançamento — pela máquina que já existe.
 *
 * Submeter um lançamento de colaborador cria uma movimentação
 * (`fdp_employee_movements`) com a etapa de aprovação correspondente. Não é
 * decoração: a movimentação entra na fila de aprovações que a Operação DP já
 * desenha, herda a segregação contra autoaprovação e passa a **barrar o
 * fechamento da competência** enquanto não for decidida — que é o
 * comportamento certo para um desconto que ainda não foi autorizado.
 *
 * Prestador PJ não tem movimentação: `fdp_employee_movements.employee_id` é
 * obrigatório, e inventar um colaborador para caber na tabela seria pior do que
 * não usá-la. Para PJ a aprovação vive na situação do próprio lançamento, e a
 * recusa de fechamento vem do fechamento PJ, que já existe.
 *
 * Aprovar **não** paga e **não** desconta. São três controles separados: este
 * autoriza a existência da obrigação; `ledger.pay` registra o dinheiro que sai
 * para a pessoa; `ledger.confirm` registra o que foi efetivamente descontado.
 */
async function loadEntry(
  d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"],
  workspaceId: string,
  id: string,
) {
  const entry = await d1.prepare(`SELECT entry.id, entry.company_id, entry.employee_id, entry.provider_id,
      entry.category, entry.title, entry.status, entry.movement_id, entry.first_competence,
      entry.total_amount, entry.requested_by
    FROM fdp_ledger_entries entry
    WHERE entry.workspace_id = ? AND entry.id = ?`).bind(workspaceId, id).first<Record<string, unknown>>();
  if (!entry) throw ApiError.notFound("Lançamento não encontrado.", "LEDGER_ENTRY_NOT_FOUND");
  return entry;
}

/** Envia o lançamento para aprovação. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.request", "enviar um lançamento para aprovação");

    const entry = await loadEntry(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(entry.company_id));
    if (entry.status !== "draft" && entry.status !== "rejected") {
      throw ApiError.badRequest("Só um rascunho ou um lançamento recusado pode ser enviado para aprovação.", "LEDGER_NOT_SUBMITTABLE");
    }

    const approverUserId = cleanText(body.approverUserId, 120);
    if (!approverUserId) throw ApiError.badRequest("Selecione quem vai aprovar.", "LEDGER_APPROVER_REQUIRED");
    /* Segregação: quem pede não aprova o próprio pedido. A mesma regra que a
       Operação DP aplica às movimentações, aplicada aqui na porta de entrada
       em vez de só na hora de decidir — é mais barato recusar agora do que
       deixar a aprovação chegar numa fila onde ninguém pode decidi-la. */
    if (approverUserId === user.id) {
      throw ApiError.badRequest("Quem solicita não pode ser quem aprova.", "LEDGER_SELF_APPROVAL");
    }
    const approver = await d1.prepare(`SELECT user_id FROM fdp_workspace_members
      WHERE workspace_id = ? AND user_id = ?`).bind(workspace.id, approverUserId).first<{ user_id: string }>();
    if (!approver) throw ApiError.badRequest("A pessoa escolhida não faz parte deste grupo.", "LEDGER_APPROVER_NOT_MEMBER");

    const requestId = request.headers.get("x-fila-dp-request-id");
    const statements = [];
    let movementId = entry.movement_id ? String(entry.movement_id) : null;

    if (entry.employee_id && !movementId) {
      movementId = crypto.randomUUID();
      const movementType = entry.category === "salary_advance" ? "salary_advance" : "payroll_discount";
      /* A vigência da movimentação é o primeiro dia da competência inicial: é
         quando o desconto começa a valer, e é o que faz a movimentação aparecer
         no ciclo certo da Operação DP. */
      const effectiveDate = `${String(entry.first_competence)}-01`;
      statements.push(
        d1.prepare(`INSERT INTO fdp_employee_movements
          (id, workspace_id, company_id, employee_id, movement_type, effective_date, title, details_json, status, requested_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'pending_approval', ?)`)
          .bind(movementId, workspace.id, entry.company_id, entry.employee_id, movementType, effectiveDate,
            String(entry.title), JSON.stringify({ ledgerEntryId: id, category: entry.category }), user.id),
        d1.prepare(`INSERT INTO fdp_movement_approval_steps
          (id, workspace_id, movement_id, sequence, approver_user_id, status)
          VALUES (?, ?, ?, 1, ?, 'pending')`)
          .bind(crypto.randomUUID(), workspace.id, movementId, approverUserId),
      );
    } else if (movementId) {
      statements.push(
        d1.prepare(`UPDATE fdp_employee_movements SET status = 'pending_approval', updated_at = now()
          WHERE workspace_id = ? AND id = ?`).bind(workspace.id, movementId),
        d1.prepare(`UPDATE fdp_movement_approval_steps SET status = 'pending', decided_at = NULL, comment = ''
          WHERE workspace_id = ? AND movement_id = ?`).bind(workspace.id, movementId),
      );
    }

    statements.push(
      d1.prepare(`UPDATE fdp_ledger_entries SET status = 'pending_approval', movement_id = ?,
          responsible_user_id = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND status IN ('draft', 'rejected')`)
        .bind(movementId, approverUserId, user.id, workspace.id, id),
      d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'submitted', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, "Enviado para aprovação",
          JSON.stringify({ approverUserId, movementId }), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_entry.submitted", entityType: "ledger_entry", entityId: id,
        before: { status: String(entry.status) }, after: { status: "pending_approval" },
        metadata: { approverUserId, movementId }, requestId,
      }),
    );

    await d1.batch(statements);
    return Response.json({ entry: { id, status: "pending_approval", movementId, approverUserId } });
  } catch (error) { return apiError(error); }
}

/**
 * Decide o lançamento.
 *
 * Aprovar coloca o lançamento em desconto e libera as parcelas já programadas.
 * Nenhuma delas nasce confirmada — aprovar autoriza o desconto, não o executa.
 *
 * Recusar devolve o lançamento a quem pediu, com o motivo obrigatório: um
 * "não" sem razão escrita obriga a pessoa a abrir um chamado para descobrir o
 * que corrigir.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.approve", "aprovar ou recusar um lançamento");

    const entry = await loadEntry(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(entry.company_id));
    if (entry.status !== "pending_approval") {
      throw ApiError.badRequest("Este lançamento não está aguardando aprovação.", "LEDGER_NOT_PENDING");
    }
    if (String(entry.requested_by) === user.id) {
      throw ApiError.badRequest("Quem solicitou não pode aprovar o próprio lançamento.", "LEDGER_SELF_APPROVAL");
    }

    const decision = cleanText(body.decision, 20);
    if (decision !== "approve" && decision !== "reject") {
      throw ApiError.badRequest("Informe se o lançamento foi aprovado ou recusado.", "LEDGER_DECISION_REQUIRED");
    }
    const note = cleanText(body.note, 1000);
    if (decision === "reject" && note.length < 5) {
      throw ApiError.badRequest("Informe o motivo da recusa.", "LEDGER_REJECT_REASON_REQUIRED");
    }

    const approved = decision === "approve";
    const nextStatus = approved ? "active" : "rejected";
    const movementId = entry.movement_id ? String(entry.movement_id) : null;
    const requestId = request.headers.get("x-fila-dp-request-id");

    const statements = [
      /* O `WHERE` carrega a situação esperada: se outra pessoa decidiu no
         intervalo entre a leitura e a escrita, o UPDATE não pega linha nenhuma
         e a decisão não é aplicada duas vezes. */
      d1.prepare(`UPDATE fdp_ledger_entries SET status = ?, approval_note = ?, approved_by = ?, approved_at = now(),
          updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND status = 'pending_approval'`)
        .bind(nextStatus, note, approved ? user.id : null, user.id, workspace.id, id),
      d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, ?, ?, '{}'::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, approved ? "approved" : "rejected",
          note || (approved ? "Aprovado" : "Recusado"), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: approved ? "ledger_entry.approved" : "ledger_entry.rejected",
        entityType: "ledger_entry", entityId: id,
        before: { status: "pending_approval" }, after: { status: nextStatus },
        metadata: { movementId }, requestId,
      }),
    ];

    if (movementId) {
      statements.push(
        d1.prepare(`UPDATE fdp_employee_movements SET status = ?, decided_by = ?, decided_at = now(),
            decision_comment = ?, updated_at = now()
          WHERE workspace_id = ? AND id = ? AND status = 'pending_approval'`)
          .bind(approved ? "approved" : "rejected", user.id, note, workspace.id, movementId),
        d1.prepare(`UPDATE fdp_movement_approval_steps SET status = ?, decided_at = now(), comment = ?
          WHERE workspace_id = ? AND movement_id = ? AND status = 'pending'`)
          .bind(approved ? "approved" : "rejected", note, workspace.id, movementId),
      );
    }

    await d1.batch(statements);

    const applied = await d1.prepare(`SELECT status FROM fdp_ledger_entries WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<{ status: string }>();
    if (applied?.status !== nextStatus) {
      throw new ApiError(409, "LEDGER_DECISION_CONFLICT",
        "Alguém decidiu este lançamento enquanto você decidia. Recarregue e confira o resultado.");
    }

    return Response.json({ entry: { id, status: nextStatus, approvalNote: note } });
  } catch (error) { return apiError(error); }
}
