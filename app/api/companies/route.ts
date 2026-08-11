import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

const companyColumns = `id, parent_company_id, is_principal, legal_name, trade_name, tax_id, external_code, email, phone, status,
  tax_regime, state_registration, municipal_registration, postal_code, street, street_number, address_complement, district, city, state, country`;

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "companies.read");
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
    requireCapability(workspace, "companies.manage");
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
    const inserted = await d1.prepare(`WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext(?))
      ), entitlement AS (
        SELECT plan.company_limit FROM fdp_workspace_subscriptions subscription
        JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
        WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
      ), inserted AS (
        INSERT INTO fdp_companies
          (id, workspace_id, parent_company_id, is_principal, legal_name, trade_name, tax_id, external_code, email, phone, status, tax_regime,
           state_registration, municipal_registration, postal_code, street, street_number, address_complement, district, city, state, country)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM entitlement
        WHERE (SELECT COUNT(*) FROM fdp_companies WHERE workspace_id = ? AND status = 'active') < entitlement.company_limit
        RETURNING id
      ), demoted AS (
        UPDATE fdp_companies SET is_principal = 0, parent_company_id = ?
        WHERE ? = 1 AND workspace_id = ? AND id <> ? AND is_principal = 1 AND EXISTS (SELECT 1 FROM inserted)
        RETURNING id
      ), audited AS (
        INSERT INTO fdp_audit_events
          (id, workspace_id, actor_type, actor_user_id, actor_email, action, outcome, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
        SELECT ?, ?, 'user', ?, ?, 'company.created', 'success', 'company', inserted.id, '{}'::jsonb, ?::jsonb, '{}'::jsonb, ?
        FROM inserted RETURNING id
      ) SELECT id FROM inserted`)
      .bind(
        workspace.id, workspace.id,
        company.id, workspace.id, company.parentCompanyId, company.isPrincipal ? 1 : 0, company.legalName, company.tradeName, company.taxId,
        company.externalCode, company.email, company.phone, company.status, company.taxRegime, company.stateRegistration, company.municipalRegistration,
        company.postalCode, company.street, company.streetNumber, company.addressComplement, company.district, company.city, company.state, company.country,
        workspace.id, company.id, company.isPrincipal ? 1 : 0, workspace.id, company.id,
        crypto.randomUUID(), workspace.id, user.id, auth.user.email, JSON.stringify(company), request.headers.get("x-fila-dp-request-id"),
      ).first<{ id: string }>();
    if (!inserted) throw new ApiError(409, "PLAN_COMPANY_LIMIT", "O plano atual atingiu o limite de empresas ativas.");
    return Response.json({ company }, { status: 201 });
  } catch (error) { return apiError(error); }
}
