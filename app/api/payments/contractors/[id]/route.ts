import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText, optionalDate } from "@/lib/registrations";
import { complementMethods, openPayoutAccount, paymentEnum, payoutSummary, positiveMoney, sanitizePayoutAccount, sealPayoutAccount, withoutSealedPayout } from "@/lib/payments";
import { invoiceLimitCandidates, requireContractorProfile } from "@/lib/payment-service";
import { resolveInvoiceLimit } from "@/lib/payments";

type Params = { params: Promise<{ id: string }> };

/** Detalhe do prestador com o limite de nota efetivo e sua origem. */
export async function GET(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");
    const profile = await requireContractorProfile(d1, workspace.id, id);
    /* Sem porta por empresa: o prestador é do grupo (migração 0053). Quem
       decide aqui é a capacidade. Onde há empresa em jogo — competência,
       apuração, nota — o acesso é conferido contra a empresa daquela
       operação, que é quem paga, e não contra o cadastro. */

    const competence = cleanText(new URL(request.url).searchParams.get("competence"), 7) || new Date().toISOString().slice(0, 7);
    /* Aqui não há competência apurada, e portanto não há empresa pagadora: a
       ficha mostra o limite que valeria pela empresa sugerida no contrato.
       Sem empresa sugerida sobram as políticas de grupo e de prestador, que é
       exatamente o que se aplicaria. Quem decide de verdade é a apuração, que
       resolve o limite contra quem está pagando naquela competência. */
    const limit = resolveInvoiceLimit(
      await invoiceLimitCandidates(d1, workspace.id, profile, competence, profile.company_id ?? ""),
    );
    const stored = await d1.prepare(`SELECT payout_encrypted, payout_iv, payout_tag, payout_key_version, notes, role_title, contract_reference,
        contract_start, contract_end, complement_platform, complement_external_id, department_id, cost_center_id, responsible_user_id, status
      FROM fdp_contractor_profiles WHERE workspace_id = ? AND provider_id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    const sealedValue = String(stored?.payout_encrypted ?? "");
    const sealed = sealedValue
      ? { encryptedValue: sealedValue, initializationVector: String(stored?.payout_iv), authTag: String(stored?.payout_tag), keyVersion: Number(stored?.payout_key_version) }
      : null;

    return Response.json({
      contractor: {
        id, ...withoutSealedPayout(stored ?? {}),
        legalName: profile.legal_name, tradeName: profile.trade_name, companyId: profile.company_id,
        baseAmount: Number(profile.base_amount),
        invoiceLimitOverride: profile.invoice_limit_override === null ? null : Number(profile.invoice_limit_override),
        complementMethod: profile.complement_method,
        payout: payoutSummary(sealed, sealed ? openPayoutAccount(sealed) : null),
      },
      invoiceLimit: limit,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const profile = await requireContractorProfile(d1, workspace.id, id);
    /* Sem porta por empresa: o prestador é do grupo (migração 0053). Quem
       decide aqui é a capacidade. Onde há empresa em jogo — competência,
       apuração, nota — o acesso é conferido contra a empresa daquela
       operação, que é quem paga, e não contra o cadastro. */

    const baseAmount = positiveMoney(body.baseAmount ?? profile.base_amount, "Valor base");
    const hasOverrideField = Object.hasOwn(body, "invoiceLimitOverride");
    const overrideValue = body.invoiceLimitOverride;
    const invoiceLimitOverride = hasOverrideField
      ? (overrideValue === null || overrideValue === "" ? null : positiveMoney(overrideValue, "Limite da nota"))
      : (profile.invoice_limit_override === null ? null : Number(profile.invoice_limit_override));
    const complementMethod = paymentEnum(body.complementMethod ?? profile.complement_method, complementMethods, "none");
    const status = body.status === "inactive" ? "inactive" : "active";
    const payout = Object.hasOwn(body, "payout") ? sealPayoutAccount(body.payout) : null;

    const statements = [
      d1.prepare(`UPDATE fdp_contractor_profiles SET contract_reference = ?, role_title = ?, department_id = ?, cost_center_id = ?,
          responsible_user_id = ?, contract_start = ?, contract_end = ?, base_amount = ?, invoice_limit_override = ?, complement_method = ?,
          complement_platform = ?, complement_external_id = ?, status = ?, notes = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND provider_id = ?`)
        .bind(cleanText(body.contractReference ?? profile.contract_reference, 80), cleanText(body.roleTitle, 120),
          cleanText(body.departmentId, 120) || null, cleanText(body.costCenterId, 120) || null, cleanText(body.responsibleUserId, 120) || null,
          optionalDate(body.contractStart), optionalDate(body.contractEnd), baseAmount, invoiceLimitOverride, complementMethod,
          cleanText(body.complementPlatform, 80), cleanText(body.complementExternalId, 160), status, cleanText(body.notes, 500),
          user.id, workspace.id, id),
    ];
    if (Object.hasOwn(body, "legalName") || Object.hasOwn(body, "email")) {
      statements.push(d1.prepare(`UPDATE fdp_auxiliary_providers SET legal_name = COALESCE(NULLIF(?, ''), legal_name),
          trade_name = COALESCE(NULLIF(?, ''), trade_name), email = COALESCE(NULLIF(?, ''), email), phone = COALESCE(NULLIF(?, ''), phone),
          status = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
        .bind(cleanText(body.legalName, 180), cleanText(body.tradeName, 180), cleanText(body.email, 180).toLowerCase(),
          cleanText(body.phone, 40), status, workspace.id, id));
    }
    if (payout) {
      statements.push(d1.prepare(`UPDATE fdp_contractor_profiles SET payout_encrypted = ?, payout_iv = ?, payout_tag = ?, payout_key_version = ?, updated_at = now()
        WHERE workspace_id = ? AND provider_id = ?`)
        .bind(payout.encryptedValue, payout.initializationVector, payout.authTag, payout.keyVersion, workspace.id, id));
    }
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "contractor.updated", entityType: "contractor", entityId: id,
      before: {
        baseAmount: Number(profile.base_amount),
        invoiceLimitOverride: profile.invoice_limit_override === null ? null : Number(profile.invoice_limit_override),
        complementMethod: profile.complement_method, status: profile.status,
      },
      after: { baseAmount, invoiceLimitOverride, complementMethod, status },
      metadata: { payoutRotated: Boolean(payout), payoutFields: Object.keys(sanitizePayoutAccount(body.payout)) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    await d1.batch(statements);
    return Response.json({ contractor: { id, baseAmount, invoiceLimitOverride, complementMethod, status } });
  } catch (error) {
    return apiError(error);
  }
}
