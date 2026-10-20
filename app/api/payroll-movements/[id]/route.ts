import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

/**
 * Remover um lançamento. Corrigir é remover e lançar de novo: o lançamento é
 * pequeno, e editar no lugar esconderia o que já tinha ido numa planilha.
 * Lançamento já exportado pode ser removido — a folha é do Sankhya —, e a
 * trilha guarda que ele tinha saído.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "hr.write");
    const row = await d1.prepare(`SELECT id, company_id, competence, exported_at
      FROM fdp_payroll_movement_entries WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!row) throw ApiError.notFound("Lançamento não encontrado.", "PAYROLL_MOVEMENT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(row.company_id));

    await d1.batch([
      d1.prepare("DELETE FROM fdp_payroll_movement_entries WHERE workspace_id = ? AND id = ?").bind(workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "payroll_movements.deleted", entityType: "payroll_movement", entityId: id,
        before: { competence: String(row.competence), exported: Boolean(row.exported_at) },
        metadata: { companyId: String(row.company_id) },
      }),
    ]);
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
