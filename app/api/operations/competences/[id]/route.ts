import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "competences.manage");
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
