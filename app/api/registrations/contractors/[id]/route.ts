import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { centsFromDatabase, fromCents } from "@/lib/payments";
import { contractorBalance, requireContractorProfile } from "@/lib/payment-service";
import { assertContractValueNotBelowConsumed, movementLabels, type MovementType } from "@/lib/contractor-registry";
import { readContractorInput } from "@/lib/contractor-input";
import { dateFromDatabase } from "@/lib/registrations";

type Params = { params: Promise<{ id: string }> };

/**
 * Ficha do prestador PJ: contrato, saldo, valores fixos e histórico.
 *
 * Reúne numa resposta só o que a tela precisa para responder as perguntas do
 * dia a dia — quanto ele custa por mês, quanto do contrato sobrou, o que se
 * repete todo mês e o que já mudou. Buscar isso em quatro chamadas deixaria a
 * tela montando o mesmo quebra-cabeça a cada abertura.
 */

export async function GET(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.read");

    const profile = await requireContractorProfile(d1, workspace.id, id);
    /* Sem porta por empresa: o prestador é do grupo (migração 0054). Quem
       decide aqui é a capacidade. Onde há empresa em jogo — competência,
       apuração, nota — o acesso é conferido contra a empresa daquela
       operação, que é quem paga, e não contra o cadastro. */

    const canReadPayments = hasCapability(workspace, "contractors.payments.read");
    const [identity, detail, fixedItems, movements, closings] = await Promise.all([
      d1.prepare(`SELECT a.code, a.legal_name, a.trade_name, a.tax_id, a.email, a.phone, a.status AS provider_status
        FROM fdp_auxiliary_providers a WHERE a.workspace_id = ? AND a.id = ?`)
        .bind(workspace.id, id).first<Record<string, unknown>>(),
      d1.prepare(`SELECT p.role_title, p.contract_signed_at, p.payment_day, p.notes, p.invoice_limit_override,
          COALESCE(c.trade_name, c.legal_name) AS company_name
        FROM fdp_contractor_profiles p
        LEFT JOIN fdp_companies c ON c.workspace_id = p.workspace_id AND c.id = p.company_id
        WHERE p.workspace_id = ? AND p.provider_id = ?`).bind(workspace.id, id).first<Record<string, unknown>>(),
      d1.prepare(`SELECT id, direction, component_type, description, amount, effective_from, effective_to, status, note
        FROM fdp_contractor_fixed_items WHERE workspace_id = ? AND provider_id = ?
        ORDER BY status, effective_from DESC`).bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, movement_type, effective_date, title, reason, status, before_json, after_json,
          requested_by, decided_at, applied_at, decision_comment, created_at
        FROM fdp_contractor_movements WHERE workspace_id = ? AND provider_id = ?
        ORDER BY effective_date DESC, created_at DESC LIMIT 50`).bind(workspace.id, id).all<Record<string, unknown>>(),
      canReadPayments
        ? d1.prepare(`SELECT id, company_id, competence, status, net_amount, invoice_expected_amount,
            complement_amount, fixed_caju_amount, caju_amount
          FROM fdp_contractor_closings WHERE workspace_id = ? AND provider_id = ? AND excluded_at IS NULL
          ORDER BY competence DESC LIMIT 60`).bind(workspace.id, id).all<Record<string, unknown>>()
        : Promise.resolve({ results: [] as Record<string, unknown>[] }),
    ]);

    const balance = await contractorBalance(d1, workspace.id, profile);
    const taxId = String(identity?.tax_id ?? "");

    return Response.json({
      contractor: {
        id,
        code: identity?.code ?? "",
        legalName: identity?.legal_name ?? "",
        tradeName: identity?.trade_name ?? "",
        // Documento mascarado: a ficha identifica sem expor o número inteiro.
        taxIdMasked: taxId ? `${"•".repeat(Math.max(taxId.length - 4, 0))}${taxId.slice(-4)}` : "",
        taxIdLength: taxId.length,
        email: identity?.email ?? "",
        phone: identity?.phone ?? "",
        companyId: profile.company_id,
        companyName: detail?.company_name ?? "",
        contractReference: profile.contract_reference,
        roleTitle: detail?.role_title ?? "",
        contractType: profile.contract_type,
        contractStart: dateFromDatabase(profile.contract_start, "Início do contrato"),
        contractEnd: dateFromDatabase(profile.contract_end, "Término do contrato"),
        contractSignedAt: dateFromDatabase(detail?.contract_signed_at, "Assinatura do contrato"),
        paymentDay: detail?.payment_day ?? null,
        baseAmountCents: centsFromDatabase(profile.base_amount, "Valor fixo"),
        fixedCajuDifferenceCents: centsFromDatabase(profile.fixed_caju_difference, "Diferença fixa no Caju"),
        invoiceLimitCents: detail?.invoice_limit_override === null || detail?.invoice_limit_override === undefined
          ? null
          : centsFromDatabase(detail.invoice_limit_override, "Limite da nota"),
        complementMethod: profile.complement_method,
        status: profile.status,
        notes: detail?.notes ?? "",
      },
      balance,
      fixedItems: fixedItems.results.map((row) => ({
        id: row.id,
        direction: row.direction,
        componentType: row.component_type,
        description: row.description,
        amountCents: centsFromDatabase(row.amount, "Valor fixo"),
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        status: row.status,
        note: row.note,
      })),
      movements: movements.results.map((row) => ({
        id: row.id,
        movementType: row.movement_type,
        movementLabel: movementLabels[row.movement_type as MovementType] ?? row.movement_type,
        effectiveDate: row.effective_date,
        title: row.title,
        reason: row.reason,
        status: row.status,
        before: row.before_json,
        after: row.after_json,
        decidedAt: row.decided_at,
        appliedAt: row.applied_at,
        decisionComment: row.decision_comment,
        createdAt: row.created_at,
      })),
      closings: closings.results.map((row) => ({
        id: row.id,
        companyId: row.company_id,
        competence: row.competence,
        status: row.status,
        netCents: centsFromDatabase(row.net_amount, "Líquido"),
        invoiceCents: centsFromDatabase(row.invoice_expected_amount, "Nota esperada"),
        complementCents: centsFromDatabase(row.complement_amount, "Complemento"),
        fixedCajuCents: centsFromDatabase(row.fixed_caju_amount, "Diferença fixa no Caju"),
        cajuCents: centsFromDatabase(row.caju_amount, "Caju"),
      })),
      permissions: { manage: hasCapability(workspace, "contractors.manage"), readPayments: canReadPayments },
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
    requireCapability(workspace, "contractors.manage");

    const profile = await requireContractorProfile(d1, workspace.id, id);
    /* Sem porta por empresa: o prestador é do grupo (migração 0054). Quem
       decide aqui é a capacidade. Onde há empresa em jogo — competência,
       apuração, nota — o acesso é conferido contra a empresa daquela
       operação, que é quem paga, e não contra o cadastro. */

    const currentIdentity = await d1.prepare("SELECT tax_id FROM fdp_auxiliary_providers WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ tax_id: string }>();
    const taxId = String(body.taxId ?? "").trim() || currentIdentity?.tax_id || "";
    const input = readContractorInput({ companyId: profile.company_id, ...body, taxId }, { requireCompany: false });
    if (input.companyId && input.companyId !== profile.company_id) {
      await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);
    }

    // Reduzir o valor global abaixo do já consumido apagaria competências
    // fechadas do ponto de vista do saldo. A recusa vem antes da escrita.
    const balance = await contractorBalance(d1, workspace.id, profile);
    assertContractValueNotBelowConsumed(input.contractTotalCents, balance.consumedCents);

    const before = {
      contractType: profile.contract_type,
      contractEnd: profile.contract_end,
      baseAmountCents: centsFromDatabase(profile.base_amount, "Valor fixo"),
      fixedCajuDifferenceCents: centsFromDatabase(profile.fixed_caju_difference, "Diferença fixa no Caju"),
      status: profile.status,
    };

    await d1.batch([
      d1.prepare(`UPDATE fdp_auxiliary_providers SET legal_name = ?, trade_name = ?, tax_id = ?, email = ?, phone = ?,
          status = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
        .bind(input.legalName, input.tradeName, input.taxId, input.email, input.phone,
          input.status === "inactive" ? "inactive" : "active", workspace.id, id),
      d1.prepare(`UPDATE fdp_contractor_profiles SET company_id = ?, contract_reference = ?, role_title = ?,
          contract_type = ?, contract_start = ?, contract_end = ?, contract_total_amount = ?, contract_signed_at = ?,
          base_amount = ?, fixed_caju_difference = ?, invoice_limit_override = ?, complement_method = ?, payment_day = ?, status = ?, notes = ?,
          updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND provider_id = ?`)
        .bind(input.companyId || profile.company_id || null, input.contractReference, input.roleTitle,
          input.contractType, input.contractStart, input.contractEnd,
          input.contractTotalCents === null ? null : fromCents(input.contractTotalCents),
          input.contractSignedAt, fromCents(input.baseAmountCents), fromCents(input.fixedCajuDifferenceCents),
          input.invoiceLimitCents === null ? null : fromCents(input.invoiceLimitCents),
          input.complementMethod, input.paymentDay, input.status, input.notes, user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor.updated", entityType: "contractor", entityId: id,
        before,
        after: {
          contractType: input.contractType, contractEnd: input.contractEnd,
          baseAmountCents: input.baseAmountCents, fixedCajuDifferenceCents: input.fixedCajuDifferenceCents,
          status: input.status, contractTotalCents: input.contractTotalCents,
        },
        metadata: { consumedCents: balance.consumedCents },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
