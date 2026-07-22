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
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    await d1.prepare(`UPDATE fdp_companies SET legal_name = ?, trade_name = ?, tax_id = ?, external_code = ?, email = ?, phone = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?`)
      .bind(legalName, text(body.tradeName, 160), text(body.taxId ?? body.cnpj, 30), text(body.externalCode, 80), text(body.email, 160), text(body.phone, 40), body.status === "inactive" ? "inactive" : "active", id, workspace.id)
      .run();
    await recordActivity(workspace.id, null, auth.user.email, "company.updated", { companyId: id });
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
