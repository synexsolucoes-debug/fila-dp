import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { sanitizeProviderCode } from "@/lib/auxiliary";
import { cleanText, optionalDate } from "@/lib/registrations";
import { complementMethods, paymentEnum, payoutSummary, positiveMoney, sanitizePayoutAccount, sealPayoutAccount, withoutSealedPayout } from "@/lib/payments";

/** Cadastro do prestador PJ: contrato, valor base, limite próprio e meio complementar. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ contractors: [] });
    const where = ["p.workspace_id = ?"];
    const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`p.company_id IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }
    if (companyId) { where.push("p.company_id = ?"); values.push(companyId); }

    const rows = await d1.prepare(`SELECT p.provider_id, p.company_id, p.contract_reference, p.role_title, p.department_id, p.cost_center_id,
        p.contract_start, p.contract_end, p.base_amount, p.invoice_limit_override, p.complement_method, p.complement_platform,
        p.complement_external_id, p.status, p.notes, p.payout_encrypted, p.payout_key_version,
        a.code, a.legal_name, a.trade_name, a.tax_id, a.email, a.phone
      FROM fdp_contractor_profiles p
      JOIN fdp_auxiliary_providers a ON a.workspace_id = p.workspace_id AND a.id = p.provider_id
      WHERE ${where.join(" AND ")} ORDER BY p.status, a.legal_name`).bind(...values).all<Record<string, unknown>>();

    return Response.json({
      contractors: rows.results.map((row) => {
        const sealed = row.payout_encrypted;
        return {
          ...withoutSealedPayout(row),
          baseAmount: Number(row.base_amount ?? 0),
          invoiceLimitOverride: row.invoice_limit_override === null ? null : Number(row.invoice_limit_override),
          payout: payoutSummary(sealed ? { encryptedValue: String(sealed), initializationVector: "", authTag: "", keyVersion: Number(row.payout_key_version ?? 0) } : null, null),
        };
      }),
      permissions: {
        manage: hasCapability(workspace, "contractors.payments.manage"),
        close: hasCapability(workspace, "contractors.payments.close"),
        manageLimits: hasCapability(workspace, "contractors.limits.manage"),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const companyId = cleanText(body.companyId, 120);
    const legalName = cleanText(body.legalName, 180);
    if (!companyId || !legalName) throw ApiError.badRequest("Empresa e razão social são obrigatórias.", "CONTRACTOR_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const code = sanitizeProviderCode(body.code ?? legalName);
    const baseAmount = positiveMoney(body.baseAmount, "Valor base");
    const hasOverride = body.invoiceLimitOverride !== undefined && body.invoiceLimitOverride !== null && body.invoiceLimitOverride !== "";
    const invoiceLimitOverride = hasOverride ? positiveMoney(body.invoiceLimitOverride, "Limite da nota") : null;
    const complementMethod = paymentEnum(body.complementMethod, complementMethods, "none");
    const payout = sealPayoutAccount(body.payout);
    const providerId = crypto.randomUUID();

    const duplicate = await d1.prepare("SELECT id FROM fdp_auxiliary_providers WHERE workspace_id = ? AND code = ?").bind(workspace.id, code).first();
    if (duplicate) throw new ApiError(409, "PROVIDER_CODE_CONFLICT", "Já existe um fornecedor com este código.");

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, trade_name, tax_id, email, phone, status)
        VALUES (?, ?, 'contractor', ?, ?, ?, ?, ?, ?, 'active')`)
        .bind(providerId, workspace.id, code, legalName, cleanText(body.tradeName, 180), cleanText(body.taxId, 20).replace(/\D/gu, ""),
          cleanText(body.email, 180).toLowerCase(), cleanText(body.phone, 40)),
      d1.prepare(`INSERT INTO fdp_contractor_profiles (provider_id, workspace_id, company_id, contract_reference, role_title, department_id, cost_center_id,
          responsible_user_id, contract_start, contract_end, base_amount, invoice_limit_override, complement_method, complement_platform,
          complement_external_id, payout_encrypted, payout_iv, payout_tag, payout_key_version, status, notes, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .bind(providerId, workspace.id, companyId, cleanText(body.contractReference, 80), cleanText(body.roleTitle, 120),
          cleanText(body.departmentId, 120) || null, cleanText(body.costCenterId, 120) || null, cleanText(body.responsibleUserId, 120) || null,
          optionalDate(body.contractStart), optionalDate(body.contractEnd), baseAmount, invoiceLimitOverride, complementMethod,
          cleanText(body.complementPlatform, 80), cleanText(body.complementExternalId, 160),
          payout?.encryptedValue ?? "", payout?.initializationVector ?? "", payout?.authTag ?? "", payout?.keyVersion ?? 0,
          cleanText(body.notes, 500), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor.created", entityType: "contractor", entityId: providerId,
        after: { code, legalName, companyId, baseAmount, invoiceLimitOverride, complementMethod },
        metadata: { payoutConfigured: Boolean(payout), payoutFields: Object.keys(sanitizePayoutAccount(body.payout)) },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ contractor: { id: providerId, code, legalName, companyId, baseAmount, invoiceLimitOverride, complementMethod } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
