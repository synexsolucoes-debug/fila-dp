import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { sanitizeProviderCode } from "@/lib/auxiliary";
import { fromCents, centsFromDatabase } from "@/lib/payments";
import { contractBalance, type ContractType } from "@/lib/contractor-registry";
import { readContractorInput } from "@/lib/contractor-input";

/**
 * Cadastro de prestador PJ.
 *
 * O prestador vive em duas tabelas: `fdp_auxiliary_providers` guarda quem ele é
 * e `fdp_contractor_profiles` guarda o contrato. As duas nascem juntas, na mesma
 * transação — um prestador sem contrato apareceria na lista sem poder ser
 * apurado, e a operação não teria como saber por quê.
 */

type ListRow = {
  provider_id: string; code: string; legal_name: string; trade_name: string; tax_id: string;
  company_id: string; company_name: string; contract_reference: string; role_title: string;
  contract_type: string; contract_start: string | null; contract_end: string | null;
  contract_total_amount: string | number | null; base_amount: string | number;
  complement_method: string; status: string; consumed: string | number; fixed_items: number;
};

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.read");

    const url = new URL(request.url);
    const companyFilter = url.searchParams.get("companyId") ?? "";

    // O consumido entra na própria consulta: buscar fechamento por prestador em
    // laço deixaria a lista lenta já com algumas dezenas de contratos.
    const rows = await d1.prepare(`SELECT p.provider_id, a.code, a.legal_name, a.trade_name, a.tax_id,
        p.company_id, COALESCE(c.trade_name, c.legal_name) AS company_name,
        p.contract_reference, p.role_title, p.contract_type, p.contract_start, p.contract_end,
        p.contract_total_amount, p.base_amount, p.complement_method, p.status,
        COALESCE((SELECT SUM(cl.net_amount) FROM fdp_contractor_closings cl
          WHERE cl.workspace_id = p.workspace_id AND cl.provider_id = p.provider_id
            AND cl.status IN ('approved', 'invoice_pending', 'ready_to_pay', 'paid', 'closed')), 0) AS consumed,
        COALESCE((SELECT COUNT(*) FROM fdp_contractor_fixed_items fi
          WHERE fi.workspace_id = p.workspace_id AND fi.provider_id = p.provider_id AND fi.status = 'active'), 0) AS fixed_items
      FROM fdp_contractor_profiles p
      JOIN fdp_auxiliary_providers a ON a.workspace_id = p.workspace_id AND a.id = p.provider_id
      LEFT JOIN fdp_companies c ON c.workspace_id = p.workspace_id AND c.id = p.company_id
      WHERE p.workspace_id = ? AND (? = '' OR p.company_id = ?)
      ORDER BY p.status, a.legal_name`)
      .bind(workspace.id, companyFilter, companyFilter).all<ListRow>();

    return Response.json({
      contractors: rows.results.map((row) => {
        const balance = contractBalance({
          contractType: row.contract_type as ContractType,
          contractTotalCents: row.contract_total_amount === null || row.contract_total_amount === undefined
            ? null
            : centsFromDatabase(row.contract_total_amount, "Valor do contrato"),
          consumedCents: centsFromDatabase(row.consumed, "Consumo do contrato"),
        });
        return {
          id: row.provider_id,
          code: row.code,
          legalName: row.legal_name,
          tradeName: row.trade_name,
          // Só os últimos dígitos na lista: identificar o prestador não exige o
          // documento inteiro na tela.
          taxIdLast4: String(row.tax_id ?? "").slice(-4),
          companyId: row.company_id,
          companyName: row.company_name ?? "",
          contractReference: row.contract_reference,
          roleTitle: row.role_title,
          contractType: row.contract_type,
          contractStart: row.contract_start,
          contractEnd: row.contract_end,
          baseAmountCents: centsFromDatabase(row.base_amount, "Valor fixo"),
          complementMethod: row.complement_method,
          status: row.status,
          fixedItemCount: Number(row.fixed_items ?? 0),
          balance,
        };
      }),
      permissions: {
        manage: hasCapability(workspace, "contractors.manage"),
        payments: hasCapability(workspace, "contractors.payments.read"),
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
    requireCapability(workspace, "contractors.manage");

    const input = readContractorInput(body, { requireCompany: true });
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);

    const code = sanitizeProviderCode(body.code ?? input.legalName);
    const duplicate = await d1.prepare("SELECT id FROM fdp_auxiliary_providers WHERE workspace_id = ? AND code = ?")
      .bind(workspace.id, code).first();
    if (duplicate) throw new ApiError(409, "PROVIDER_CODE_CONFLICT", "Já existe um prestador com este código.");

    const providerId = crypto.randomUUID();
    // Identidade e contrato nascem juntos: um prestador sem contrato apareceria
    // na lista sem poder ser apurado, e ninguém saberia dizer por quê.
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, trade_name, tax_id, email, phone, status)
        VALUES (?, ?, 'contractor', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(providerId, workspace.id, code, input.legalName, input.tradeName, input.taxId,
          input.email, input.phone, input.status === "inactive" ? "inactive" : "active"),
      d1.prepare(`INSERT INTO fdp_contractor_profiles (provider_id, workspace_id, company_id, contract_reference, role_title,
          contract_type, contract_start, contract_end, contract_total_amount, contract_signed_at, base_amount,
          invoice_limit_override, complement_method, payment_day, status, notes, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(providerId, workspace.id, input.companyId, input.contractReference, input.roleTitle,
          input.contractType, input.contractStart, input.contractEnd,
          input.contractTotalCents === null ? null : fromCents(input.contractTotalCents),
          input.contractSignedAt, fromCents(input.baseAmountCents),
          input.invoiceLimitCents === null ? null : fromCents(input.invoiceLimitCents),
          input.complementMethod, input.paymentDay, input.status, input.notes, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor.created", entityType: "contractor", entityId: providerId,
        before: null,
        // O documento não entra na trilha: identificar o registro não exige
        // repetir CNPJ ou CPF no histórico.
        after: {
          code, legalName: input.legalName, companyId: input.companyId, contractType: input.contractType,
          baseAmountCents: input.baseAmountCents, contractTotalCents: input.contractTotalCents,
        },
        metadata: { contractStart: input.contractStart, contractEnd: input.contractEnd },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ contractor: { id: providerId, code, legalName: input.legalName } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
