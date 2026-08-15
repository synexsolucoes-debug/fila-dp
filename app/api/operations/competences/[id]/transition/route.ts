import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { closingBlockerMessage, cycleStatuses, describeClosingBlockers, enumOr } from "@/lib/operations";

const allowed: Record<string, string[]> = { open: ["pre_closing"], pre_closing: ["open", "processing"], processing: ["pre_closing", "post_closing"], post_closing: ["processing", "closed"], closed: ["post_closing"] };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "competences.transition");
    const cycle = await d1.prepare("SELECT * FROM fdp_payroll_cycles WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!cycle) throw ApiError.notFound("Competência não encontrada.", "COMPETENCE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(cycle.company_id));
    const target = enumOr(body.status, cycleStatuses, String(cycle.status) as typeof cycleStatuses[number]);
    if (!allowed[String(cycle.status)]?.includes(target)) throw ApiError.badRequest("Transição de competência não permitida.", "INVALID_COMPETENCE_TRANSITION");
    const reopening = cycle.status === "closed";
    const reason = cleanText(body.reason, 500);
    if (reopening) {
      requireCapability(workspace, "competences.reopen");
      if (!reason) throw ApiError.badRequest("Informe o motivo da reabertura.", "REOPEN_REASON_REQUIRED");
    }
    const blocksClosing = target === "processing" || target === "closed";
    const gates = blocksClosing ? `AND NOT EXISTS (SELECT 1 FROM fdp_operational_pending_items p WHERE p.workspace_id = c.workspace_id AND p.payroll_cycle_id = c.id AND p.blocking = 1 AND p.status IN ('open', 'in_progress'))
      AND NOT EXISTS (SELECT 1 FROM fdp_employee_movements m WHERE m.workspace_id = c.workspace_id AND m.payroll_cycle_id = c.id AND m.status IN ('draft', 'pending_approval', 'rejected'))
      ${target === "closed" ? "AND NOT EXISTS (SELECT 1 FROM fdp_payroll_cycle_items i WHERE i.workspace_id = c.workspace_id AND i.payroll_cycle_id = c.id AND i.status <> 'completed') AND NOT EXISTS (SELECT 1 FROM fdp_compliance_obligations o WHERE o.workspace_id = c.workspace_id AND o.payroll_cycle_id = c.id AND o.status <> 'completed') AND NOT EXISTS (SELECT 1 FROM fdp_auxiliary_executions auxiliary WHERE auxiliary.workspace_id = c.workspace_id AND auxiliary.payroll_cycle_id = c.id AND auxiliary.status NOT IN ('closed', 'canceled'))" : ""}` : "";
    const result = await d1.prepare(`WITH updated AS (
        UPDATE fdp_payroll_cycles c SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE c.workspace_id = ? AND c.id = ? AND c.status = ? ${gates} RETURNING c.*
      ), audited AS (
        INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
        SELECT ?, workspace_id, ?, ?, 'competence.transitioned', 'payroll_cycle', id, ?::jsonb, jsonb_build_object('status', status), ?::jsonb, ? FROM updated
      ) SELECT * FROM updated`)
      .bind(target, target, workspace.id, id, cycle.status, crypto.randomUUID(), user.id, auth.user.email,
        JSON.stringify({ status: cycle.status }), JSON.stringify({ reason: reason || null }), request.headers.get("x-fila-dp-request-id")).first<Record<string, unknown>>();
    if (!result) {
      // Os portões ficam no `WHERE` do UPDATE para não abrir janela entre
      // conferir e aplicar. Isso deixava a resposta sabendo apenas que algo
      // barrou; o diagnóstico roda agora, depois do bloqueio, para dizer o quê.
      const blockers = await describeClosingBlockers(d1, workspace.id, id, target);
      throw new ApiError(409, "COMPETENCE_BLOCKED", closingBlockerMessage(blockers), { blockers });
    }
    return Response.json({ competence: result });
  } catch (error) { return apiError(error); }
}
