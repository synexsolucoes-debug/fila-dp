import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { generateContractorStatementsPdf, type ContractorStatement } from "@/lib/contractor-batch-statement-pdf";
import { findContractorClosing } from "@/lib/payment-service";

type Params = { params: Promise<{ id: string }> };

type ReceiptClosingRow = {
  id: string;
  competence: string;
  base_amount: string | number;
  credits_amount: string | number;
  debits_amount: string | number;
  net_amount: string | number;
  invoice_expected_amount: string | number;
  complement_amount: string | number;
  caju_amount: string | number;
  invoice_number: string;
  invoice_received_amount: string | number;
  invoice_status: string;
  code: string;
  legal_name: string;
  trade_name: string;
  tax_id: string;
  contract_reference: string;
  role_title: string;
};

type ComponentRow = {
  direction: string;
  component_type: string;
  description: string;
  amount: string | number;
  status: string;
};

type CompanyRow = {
  legal_name: string;
  trade_name: string;
  tax_id: string;
  street: string;
  street_number: string;
  address_complement: string;
  district: string;
  city: string;
  state: string;
  postal_code: string;
};

function companyAddress(company: CompanyRow) {
  const street = [company.street, company.street_number && `nº ${company.street_number}`].filter(Boolean).join(", ");
  return [street, company.address_complement, company.district, [company.city, company.state].filter(Boolean).join(" - "), company.postal_code && `CEP ${company.postal_code}`]
    .filter(Boolean)
    .join("; ");
}

/** Gera um recibo somente para o PJ que está sendo conferido, sem mudar o fechamento. */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.read");

    const closing = await findContractorClosing(d1, workspace.id, id);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, closing.company_id);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const payerCompanyId = text(body.companyId, 120) || closing.company_id;
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, payerCompanyId);

    const [company, receiptClosing, components] = await Promise.all([
      d1.prepare(`SELECT legal_name, trade_name, tax_id, street, street_number, address_complement,
          district, city, state, postal_code FROM fdp_companies WHERE workspace_id = ? AND id = ?`)
        .bind(workspace.id, payerCompanyId)
        .first<CompanyRow>(),
      d1.prepare(`SELECT c.id, c.competence, c.base_amount, c.credits_amount, c.debits_amount, c.net_amount,
          c.invoice_expected_amount, c.complement_amount, c.caju_amount, c.invoice_number,
          c.invoice_received_amount, c.invoice_status, a.code, a.legal_name, a.trade_name, a.tax_id,
          p.contract_reference, p.role_title
        FROM fdp_contractor_closings c
        JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
        JOIN fdp_contractor_profiles p ON p.workspace_id = c.workspace_id AND p.provider_id = c.provider_id
        WHERE c.workspace_id = ? AND c.id = ? AND c.excluded_at IS NULL`)
        .bind(workspace.id, id)
        .first<ReceiptClosingRow>(),
      d1.prepare(`SELECT direction, component_type, description, amount, status
        FROM fdp_contractor_components
        WHERE workspace_id = ? AND closing_id = ? AND status = 'active'
        ORDER BY direction, created_at, id`)
        .bind(workspace.id, id)
        .all<ComponentRow>(),
    ]);
    if (!company) throw ApiError.notFound("Empresa não encontrada.", "COMPANY_NOT_FOUND");
    if (!receiptClosing) throw ApiError.notFound("Fechamento PJ não encontrado.", "CONTRACTOR_CLOSING_NOT_FOUND");

    const statement: ContractorStatement = {
      company: {
        legalName: company.legal_name,
        tradeName: company.trade_name,
        taxId: company.tax_id,
        address: companyAddress(company),
      },
      competence: receiptClosing.competence,
      issuedAt: new Date(),
      contractor: {
        code: receiptClosing.code,
        legalName: receiptClosing.legal_name,
        tradeName: receiptClosing.trade_name,
        taxId: receiptClosing.tax_id,
        contractReference: receiptClosing.contract_reference,
        roleTitle: receiptClosing.role_title,
      },
      closing: {
        baseAmount: Number(receiptClosing.base_amount),
        creditsAmount: Number(receiptClosing.credits_amount),
        debitsAmount: Number(receiptClosing.debits_amount),
        netAmount: Number(receiptClosing.net_amount),
        invoiceExpectedAmount: Number(receiptClosing.invoice_expected_amount),
        complementAmount: Number(receiptClosing.complement_amount),
        cajuAmount: Number(receiptClosing.caju_amount),
        invoiceNumber: receiptClosing.invoice_number,
        invoiceReceivedAmount: Number(receiptClosing.invoice_received_amount),
        invoiceStatus: receiptClosing.invoice_status,
      },
      components: components.results.map((component) => ({
        direction: component.direction,
        componentType: component.component_type,
        description: component.description,
        amount: Number(component.amount),
        status: component.status,
      })),
    };
    const bytes = await generateContractorStatementsPdf([statement]);
    await d1.batch([prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_receipt.downloaded",
      entityType: "contractor_closing",
      entityId: id,
      after: { competence: receiptClosing.competence, providerId: closing.provider_id },
      metadata: { canceledComponentsIncluded: false, payerCompanyId },
      requestId: request.headers.get("x-fila-dp-request-id"),
    })]);

    const filename = `recibo-pagamento-pj-${receiptClosing.competence}-${receiptClosing.code.replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`;
    const bodyBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(bodyBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
