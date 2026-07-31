import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const result = await d1.prepare("SELECT id, parent_company_id, is_principal, legal_name, trade_name, tax_id, external_code, email, phone, status FROM fdp_companies WHERE workspace_id = ? ORDER BY is_principal DESC, legal_name").bind(workspace.id).all();
    const companies = result.results.filter((company) => access.unrestricted || access.companyIds.has(String(company.id)));
    return Response.json({ companies });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const legalName = text(body.legalName ?? body.name, 160);
    const taxId = text(body.taxId ?? body.cnpj, 30);
    if (!legalName) return Response.json({ error: "Informe a razão social da empresa." }, { status: 400 });
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    if (taxId) {
      const existing = await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND tax_id = ?").bind(workspace.id, taxId).first<{ id: string }>();
      if (existing) return Response.json({ error: "Já existe uma empresa com este CNPJ no workspace." }, { status: 409 });
    }
    const requestedParentId = text(body.parentCompanyId, 120) || null;
    const requestedPrincipal = body.isPrincipal === true || body.companyType === "principal";
    if (requestedParentId) {
      const parent = await d1.prepare("SELECT id FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(requestedParentId, workspace.id).first();
      if (!parent) return Response.json({ error: "A empresa principal selecionada não pertence a este grupo." }, { status: 400 });
    }
    const currentPrincipal = await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND is_principal = 1 LIMIT 1").bind(workspace.id).first<{ id: string }>();
    const isPrincipal = requestedPrincipal || !currentPrincipal;
    const parentCompanyId = isPrincipal ? null : (requestedParentId || currentPrincipal?.id || null);
    const id = crypto.randomUUID();
    await d1.prepare(`INSERT INTO fdp_companies
      (id, workspace_id, parent_company_id, is_principal, legal_name, trade_name, tax_id, external_code, email, phone, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, workspace.id, parentCompanyId, isPrincipal ? 1 : 0, legalName, text(body.tradeName, 160), taxId, text(body.externalCode, 80), text(body.email, 160), text(body.phone, 40), body.status === "inactive" ? "inactive" : "active")
      .run();
    if (isPrincipal) await d1.prepare("UPDATE fdp_companies SET is_principal = 0, parent_company_id = ? WHERE workspace_id = ? AND id <> ? AND is_principal = 1").bind(id, workspace.id, id).run();
    await recordActivity(workspace.id, null, auth.user.email, "company.created", { companyId: id, legalName, parentCompanyId, isPrincipal });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
