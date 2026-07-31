import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const legalName = text(body.legalName ?? body.name, 160);
    if (!legalName) return Response.json({ error: "Informe a razão social da empresa." }, { status: 400 });
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const current = await d1.prepare("SELECT parent_company_id, is_principal FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).first<{ parent_company_id: string | null; is_principal: number }>();
    if (!current) return Response.json({ error: "Empresa não encontrada neste grupo." }, { status: 404 });
    const groupingWasProvided = "parentCompanyId" in body || "companyType" in body || "isPrincipal" in body;
    const requestedParentId = groupingWasProvided ? (text(body.parentCompanyId, 120) || null) : current.parent_company_id;
    const isPrincipal = groupingWasProvided ? (body.isPrincipal === true || body.companyType === "principal") : Boolean(current.is_principal);
    if (requestedParentId && requestedParentId === id) return Response.json({ error: "Uma empresa não pode ser principal dela mesma." }, { status: 400 });
    if (requestedParentId) {
      const parent = await d1.prepare("SELECT id FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(requestedParentId, workspace.id).first();
      if (!parent) return Response.json({ error: "A empresa principal selecionada não pertence a este grupo." }, { status: 400 });
    }
    await d1.prepare(`UPDATE fdp_companies SET legal_name = ?, trade_name = ?, tax_id = ?, external_code = ?, email = ?, phone = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      , parent_company_id = ?, is_principal = ? WHERE id = ? AND workspace_id = ?`)
      .bind(legalName, text(body.tradeName, 160), text(body.taxId ?? body.cnpj, 30), text(body.externalCode, 80), text(body.email, 160), text(body.phone, 40), body.status === "inactive" ? "inactive" : "active", isPrincipal ? null : requestedParentId, isPrincipal ? 1 : 0, id, workspace.id)
      .run();
    if (isPrincipal) await d1.prepare("UPDATE fdp_companies SET is_principal = 0, parent_company_id = ? WHERE workspace_id = ? AND id <> ? AND is_principal = 1").bind(id, workspace.id, id).run();
    await recordActivity(workspace.id, null, auth.user.email, "company.updated", { companyId: id, parentCompanyId: isPrincipal ? null : requestedParentId, isPrincipal });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    await d1.prepare("DELETE FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).run();
    await recordActivity(workspace.id, null, auth.user.email, "company.deleted", { companyId: id });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
