import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

const companyColumns = `id, parent_company_id, is_principal, legal_name, trade_name, tax_id, external_code, email, phone, status,
  tax_regime, state_registration, municipal_registration, postal_code, street, street_number, address_complement, district, city, state, country`;

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "companies.read");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const result = await d1.prepare(`SELECT ${companyColumns} FROM fdp_companies WHERE workspace_id = ? ORDER BY is_principal DESC, legal_name`).bind(workspace.id).all();
    return Response.json({ companies: result.results.filter((company) => access.unrestricted || access.companyIds.has(String(company.id))) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const legalName = text(body.legalName ?? body.name, 160);
    const taxId = text(body.taxId ?? body.cnpj, 30);
    if (!legalName) throw ApiError.badRequest("Informe a razão social da empresa.", "COMPANY_LEGAL_NAME_REQUIRED");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "companies.manage");
    if (taxId && await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND tax_id = ?").bind(workspace.id, taxId).first()) {
      throw new ApiError(409, "COMPANY_TAX_ID_CONFLICT", "Já existe uma empresa com este CNPJ no workspace.");
    }
    const requestedParentId = text(body.parentCompanyId, 120) || null;
    if (requestedParentId && !await d1.prepare("SELECT id FROM fdp_companies WHERE id = ? AND workspace_id = ? AND is_principal = 1").bind(requestedParentId, workspace.id).first()) {
      throw ApiError.badRequest("A empresa principal selecionada não pertence a este grupo.", "INVALID_PARENT_COMPANY");
    }
    const principal = await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND is_principal = 1 LIMIT 1").bind(workspace.id).first<{ id: string }>();
    const isPrincipal = body.isPrincipal === true || body.companyType === "principal" || !principal;
    const company = { id: crypto.randomUUID(), parentCompanyId: isPrincipal ? null : (requestedParentId || principal?.id || null), isPrincipal,
      legalName, tradeName: text(body.tradeName, 160), taxId, externalCode: text(body.externalCode, 80), email: text(body.email, 160),
      phone: text(body.phone, 40), status: body.status === "inactive" ? "inactive" : "active", taxRegime: text(body.taxRegime, 80),
      stateRegistration: text(body.stateRegistration, 40), municipalRegistration: text(body.municipalRegistration, 40), postalCode: text(body.postalCode, 20),
      street: text(body.street, 160), streetNumber: text(body.streetNumber, 30), addressComplement: text(body.addressComplement, 120),
      district: text(body.district, 100), city: text(body.city, 100), state: text(body.state, 2).toUpperCase(), country: text(body.country, 80) || "Brasil" };
    const statements: D1PreparedStatement[] = [d1.prepare(`INSERT INTO fdp_companies
      (id, workspace_id, parent_company_id, is_principal, legal_name, trade_name, tax_id, external_code, email, phone, status, tax_regime,
       state_registration, municipal_registration, postal_code, street, street_number, address_complement, district, city, state, country)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(company.id, workspace.id, company.parentCompanyId, company.isPrincipal ? 1 : 0, company.legalName, company.tradeName, company.taxId,
        company.externalCode, company.email, company.phone, company.status, company.taxRegime, company.stateRegistration, company.municipalRegistration,
        company.postalCode, company.street, company.streetNumber, company.addressComplement, company.district, company.city, company.state, company.country)];
    if (isPrincipal) statements.push(d1.prepare("UPDATE fdp_companies SET is_principal = 0, parent_company_id = ? WHERE workspace_id = ? AND id <> ? AND is_principal = 1").bind(company.id, workspace.id, company.id));
    statements.push(prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "company.created",
      entityType: "company", entityId: company.id, after: company, requestId: request.headers.get("x-fila-dp-request-id") }));
    await d1.batch(statements);
    return Response.json({ company }, { status: 201 });
  } catch (error) { return apiError(error); }
}
