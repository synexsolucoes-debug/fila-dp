import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";

/**
 * Detalhe da competência.
 *
 * A rota não existia: abrir uma competência respondia 405, e a tela não tinha
 * de onde carregar itens de fechamento, movimentações e bloqueadores. Sem isso
 * não há como saber por que um fechamento está travado.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "competences.read");
    const cycle = await d1.prepare(`SELECT c.*, co.legal_name AS company_legal_name, co.trade_name AS company_trade_name
      FROM fdp_payroll_cycles c JOIN fdp_companies co ON co.workspace_id = c.workspace_id AND co.id = c.company_id
      WHERE c.workspace_id = ? AND c.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!cycle) throw ApiError.notFound("Competência não encontrada.", "COMPETENCE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(cycle.company_id));

    const [items, movements, obligations, pendingItems] = await Promise.all([
      d1.prepare(`SELECT id, phase, category, title, status, owner_user_id, due_date, completed_at, notes, position
        FROM fdp_payroll_cycle_items WHERE workspace_id = ? AND payroll_cycle_id = ? ORDER BY phase, position`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, employee_id, movement_type, effective_date, title, status
        FROM fdp_employee_movements WHERE workspace_id = ? AND payroll_cycle_id = ? ORDER BY effective_date DESC LIMIT 200`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, obligation_type, title, due_date, status
        FROM fdp_compliance_obligations WHERE workspace_id = ? AND payroll_cycle_id = ? ORDER BY due_date`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, title, status, blocking, due_date
        FROM fdp_operational_pending_items WHERE workspace_id = ? AND payroll_cycle_id = ? ORDER BY blocking DESC, due_date`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
    ]);

    // O que impede o fechamento é dito com nome, não escondido atrás de um 409 genérico.
    const blockers = [
      ...pendingItems.results.filter((row) => Number(row.blocking) === 1 && ["open", "in_progress"].includes(String(row.status)))
        .map((row) => ({ kind: "pending_item", id: String(row.id), title: String(row.title) })),
      ...movements.results.filter((row) => ["draft", "pending_approval", "rejected"].includes(String(row.status)))
        .map((row) => ({ kind: "movement", id: String(row.id), title: String(row.title) })),
      ...items.results.filter((row) => String(row.status) !== "completed")
        .map((row) => ({ kind: "closing_item", id: String(row.id), title: String(row.title) })),
      ...obligations.results.filter((row) => String(row.status) !== "completed")
        .map((row) => ({ kind: "obligation", id: String(row.id), title: String(row.title) })),
    ];

    return Response.json({
      competence: cycle,
      items: items.results,
      movements: movements.results,
      obligations: obligations.results,
      pendingItems: pendingItems.results,
      blockers,
      canClose: blockers.length === 0,
      permissions: {
        manage: hasCapability(workspace, "competences.manage"),
        transition: hasCapability(workspace, "competences.transition"),
        reopen: hasCapability(workspace, "competences.reopen"),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "competences.manage");
    const current = await d1.prepare("SELECT * FROM fdp_payroll_cycles WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Competência não encontrada.", "COMPETENCE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    if (current.status === "closed") throw ApiError.badRequest("Reabra a competência antes de editar prazos.", "COMPETENCE_CLOSED");
    const next = {
      preClosingDueDate: Object.hasOwn(body, "preClosingDueDate") ? optionalDate(body.preClosingDueDate) : current.pre_closing_due_date,
      paymentDate: Object.hasOwn(body, "paymentDate") ? optionalDate(body.paymentDate) : current.payment_date,
      postClosingDueDate: Object.hasOwn(body, "postClosingDueDate") ? optionalDate(body.postClosingDueDate) : current.post_closing_due_date,
      notes: Object.hasOwn(body, "notes") ? cleanText(body.notes, 1000) : String(current.notes),
    };
    await d1.batch([
      d1.prepare("UPDATE fdp_payroll_cycles SET pre_closing_due_date = ?, payment_date = ?, post_closing_due_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(next.preClosingDueDate, next.paymentDate, next.postClosingDueDate, next.notes, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "competence.updated", entityType: "payroll_cycle", entityId: id, before: current, after: next, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ competence: { ...current, ...next } });
  } catch (error) { return apiError(error); }
}
