import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";

// Abrir e fechar a competência é um controle simples: sem etapas e sem gates.
// Ciclos antigos em pré-fechamento/processamento/pós-fechamento também podem ser
// fechados direto; fechar nunca altera lançamentos.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "competences.transition");
    const cycle = await d1.prepare("SELECT * FROM fdp_payroll_cycles WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!cycle) throw ApiError.notFound("Competência não encontrada.", "COMPETENCE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(cycle.company_id));
    const target = body.status === "open" || body.status === "closed" ? body.status : null;
    if (!target) throw ApiError.badRequest("Informe se a competência deve ser aberta ou fechada.", "INVALID_COMPETENCE_TRANSITION");
    const isClosed = cycle.status === "closed";
    if ((target === "closed") === isClosed) throw ApiError.badRequest(isClosed ? "A competência já está fechada." : "A competência já está aberta.", "INVALID_COMPETENCE_TRANSITION");
    const reason = cleanText(body.reason, 500);
    const result = await d1.prepare(`WITH updated AS (
        UPDATE fdp_payroll_cycles c SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE c.workspace_id = ? AND c.id = ? AND c.status = ? RETURNING c.*
      ), audited AS (
        INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
        SELECT ?, workspace_id, ?, ?, ?, 'payroll_cycle', id, ?::jsonb, jsonb_build_object('status', status), ?::jsonb, ? FROM updated
      ) SELECT * FROM updated`)
      .bind(target, target, workspace.id, id, cycle.status, crypto.randomUUID(), user.id, auth.user.email,
        target === "closed" ? "competence.closed" : "competence.reopened",
        JSON.stringify({ status: cycle.status }), JSON.stringify({ reason: reason || null }), request.headers.get("x-fila-dp-request-id")).first<Record<string, unknown>>();
    if (!result) throw new ApiError(409, "COMPETENCE_CHANGED", "A competência mudou enquanto você agia. Atualize a tela e tente de novo.");
    return Response.json({ competence: result });
  } catch (error) { return apiError(error); }
}
