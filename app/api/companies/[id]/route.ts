import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "companies.manage");
    const current = await d1.prepare("SELECT * FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Empresa não encontrada neste grupo.", "COMPANY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const value = (key: string, column: string, max: number) => Object.hasOwn(body, key) ? text(body[key], max) : String(current[column] ?? "");
    const grouping = "parentCompanyId" in body || "companyType" in body || "isPrincipal" in body;
    const isPrincipal = grouping ? (body.isPrincipal === true || body.companyType === "principal") : Boolean(current.is_principal);
    const existingPrincipal = await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND is_principal = 1 AND id <> ? LIMIT 1").bind(workspace.id, id).first<{ id: string }>();
    const parentCompanyId = isPrincipal ? null : (grouping ? text(body.parentCompanyId, 120) || existingPrincipal?.id || null : current.parent_company_id as string | null);
    if (parentCompanyId === id) throw ApiError.badRequest("Uma empresa não pode ser principal dela mesma.", "INVALID_PARENT_COMPANY");
    if (!isPrincipal && (!parentCompanyId || !await d1.prepare("SELECT id FROM fdp_companies WHERE id = ? AND workspace_id = ? AND is_principal = 1").bind(parentCompanyId, workspace.id).first())) throw ApiError.badRequest("Empresa principal inválida.", "INVALID_PARENT_COMPANY");
    const next = { id, parentCompanyId, isPrincipal, legalName: value("legalName", "legal_name", 160) || value("name", "legal_name", 160),
      tradeName: value("tradeName", "trade_name", 160), taxId: Object.hasOwn(body, "cnpj") ? text(body.cnpj, 30) : value("taxId", "tax_id", 30),
      externalCode: value("externalCode", "external_code", 80), email: value("email", "email", 160), phone: value("phone", "phone", 40),
      status: body.status === "inactive" ? "inactive" : body.status === "active" ? "active" : String(current.status), taxRegime: value("taxRegime", "tax_regime", 80),
      stateRegistration: value("stateRegistration", "state_registration", 40), municipalRegistration: value("municipalRegistration", "municipal_registration", 40),
      postalCode: value("postalCode", "postal_code", 20), street: value("street", "street", 160), streetNumber: value("streetNumber", "street_number", 30),
      addressComplement: value("addressComplement", "address_complement", 120), district: value("district", "district", 100), city: value("city", "city", 100),
      state: value("state", "state", 2).toUpperCase(), country: value("country", "country", 80) || "Brasil" };
    if (!next.legalName) throw ApiError.badRequest("Informe a razão social da empresa.", "COMPANY_LEGAL_NAME_REQUIRED");
    const statements: D1PreparedStatement[] = [d1.prepare(`UPDATE fdp_companies SET parent_company_id = ?, is_principal = ?, legal_name = ?, trade_name = ?, tax_id = ?, external_code = ?, email = ?, phone = ?, status = ?, tax_regime = ?, state_registration = ?, municipal_registration = ?, postal_code = ?, street = ?, street_number = ?, address_complement = ?, district = ?, city = ?, state = ?, country = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`)
      .bind(next.parentCompanyId, next.isPrincipal ? 1 : 0, next.legalName, next.tradeName, next.taxId, next.externalCode, next.email, next.phone, next.status,
        next.taxRegime, next.stateRegistration, next.municipalRegistration, next.postalCode, next.street, next.streetNumber, next.addressComplement,
        next.district, next.city, next.state, next.country, id, workspace.id)];
    if (isPrincipal) statements.push(d1.prepare("UPDATE fdp_companies SET is_principal = 0, parent_company_id = ? WHERE workspace_id = ? AND id <> ? AND is_principal = 1").bind(id, workspace.id, id));
    statements.push(prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "company.updated", entityType: "company", entityId: id, before: current, after: next, requestId: request.headers.get("x-fila-dp-request-id") }));
    await d1.batch(statements);
    return Response.json({ company: next });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "companies.manage");
    const current = await d1.prepare("SELECT * FROM fdp_companies WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Empresa não encontrada neste grupo.", "COMPANY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    await d1.batch([d1.prepare("UPDATE fdp_companies SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?").bind(id, workspace.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "company.inactivated", entityType: "company", entityId: id, before: current, after: { ...current, status: "inactive" }, requestId: request.headers.get("x-fila-dp-request-id") })]);
    return Response.json({ company: { ...current, status: "inactive" } });
  } catch (error) { return apiError(error); }
}
