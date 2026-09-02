import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { generateContractorStatementsPdf, type ContractorStatement } from "@/lib/contractor-batch-statement-pdf";

type ClosingRow = {
  id: string;
  provider_id: string;
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
  closing_id: string;
  direction: string;
  component_type: string;
  description: string;
  amount: string | number;
  status: string;
};

/**
 * Emite um PDF único da competência e coloca somente fechamentos ainda abertos
 * em conferência. Estados posteriores (aprovado, pago ou fechado) nunca são
 * regredidos por uma reemissão.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const companyId = cleanText(body.companyId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    if (!companyId || !cycleId) {
      throw ApiError.badRequest("Empresa e competência são obrigatórias.", "CONTRACTOR_STATEMENT_REQUIRED_FIELDS");
    }
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const cycle = await d1.prepare(`SELECT id, competence FROM fdp_payroll_cycles
      WHERE workspace_id = ? AND company_id = ? AND id = ?`)
      .bind(workspace.id, companyId, cycleId)
      .first<{ id: string; competence: string }>();
    if (!cycle) throw ApiError.notFound("Competência não encontrada.", "PAYROLL_CYCLE_NOT_FOUND");

    const company = await d1.prepare(`SELECT legal_name, trade_name FROM fdp_companies
      WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, companyId)
      .first<{ legal_name: string; trade_name: string }>();
    if (!company) throw ApiError.notFound("Empresa não encontrada.", "COMPANY_NOT_FOUND");

    const closings = await d1.prepare(`SELECT c.id, c.provider_id, c.competence, c.base_amount, c.credits_amount,
        c.debits_amount, c.net_amount, c.invoice_expected_amount, c.complement_amount, c.caju_amount,
        c.invoice_number, c.invoice_received_amount, c.invoice_status, a.code, a.legal_name, a.trade_name,
        a.tax_id, p.contract_reference, p.role_title
      FROM fdp_contractor_closings c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      JOIN fdp_contractor_profiles p ON p.workspace_id = c.workspace_id AND p.provider_id = c.provider_id
      WHERE c.workspace_id = ? AND c.company_id = ? AND c.payroll_cycle_id = ? AND c.excluded_at IS NULL
      ORDER BY a.legal_name, c.id`)
      .bind(workspace.id, companyId, cycleId)
      .all<ClosingRow>();
    if (closings.results.length === 0) {
      throw ApiError.badRequest("Apure a competência antes de emitir os extratos.", "CONTRACTOR_STATEMENT_EMPTY");
    }

    const components = await d1.prepare(`SELECT component.closing_id, component.direction, component.component_type,
        component.description, component.amount, component.status
      FROM fdp_contractor_components component
      JOIN fdp_contractor_closings closing ON closing.workspace_id = component.workspace_id AND closing.id = component.closing_id
      WHERE component.workspace_id = ? AND closing.company_id = ? AND closing.payroll_cycle_id = ?
        AND closing.excluded_at IS NULL AND component.status = 'active'
      ORDER BY component.closing_id, component.direction, component.created_at, component.id`)
      .bind(workspace.id, companyId, cycleId)
      .all<ComponentRow>();
    const componentsByClosing = new Map<string, ComponentRow[]>();
    for (const component of components.results) {
      const list = componentsByClosing.get(component.closing_id) ?? [];
      list.push(component);
      componentsByClosing.set(component.closing_id, list);
    }

    const issuedAt = new Date();
    const statements: ContractorStatement[] = closings.results.map((closing) => ({
      companyName: company.trade_name || company.legal_name,
      competence: closing.competence,
      issuedAt,
      contractor: {
        code: closing.code,
        legalName: closing.legal_name,
        tradeName: closing.trade_name,
        taxId: closing.tax_id,
        contractReference: closing.contract_reference,
        roleTitle: closing.role_title,
      },
      closing: {
        baseAmount: Number(closing.base_amount),
        creditsAmount: Number(closing.credits_amount),
        debitsAmount: Number(closing.debits_amount),
        netAmount: Number(closing.net_amount),
        invoiceExpectedAmount: Number(closing.invoice_expected_amount),
        complementAmount: Number(closing.complement_amount),
        cajuAmount: Number(closing.caju_amount),
        invoiceNumber: closing.invoice_number,
        invoiceReceivedAmount: Number(closing.invoice_received_amount),
        invoiceStatus: closing.invoice_status,
      },
      components: (componentsByClosing.get(closing.id) ?? []).map((component) => ({
        direction: component.direction,
        componentType: component.component_type,
        description: component.description,
        amount: Number(component.amount),
        status: component.status,
      })),
    }));

    const bytes = await generateContractorStatementsPdf(statements);
    const moved = closings.results.filter((closing) => closing.id);
    const placeholders = moved.map(() => "?").join(", ");
    const audit = prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_statements.issued",
      entityType: "payroll_cycle",
      entityId: cycle.id,
      after: { competence: cycle.competence, statementCount: statements.length },
      metadata: { companyId, openClosingsMovedToReview: true, canceledComponentsIncluded: false },
      requestId: request.headers.get("x-fila-dp-request-id"),
    });
    await d1.batch([
      d1.prepare(`UPDATE fdp_contractor_closings SET status = 'review', updated_at = now()
        WHERE workspace_id = ? AND company_id = ? AND payroll_cycle_id = ?
          AND excluded_at IS NULL AND status IN ('open', 'reopened') AND id IN (${placeholders})`)
        .bind(workspace.id, companyId, cycleId, ...moved.map((closing) => closing.id)),
      audit,
    ]);

    const filename = `recibos-pj-${cycle.competence}.pdf`;
    const bodyBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(bodyBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Statement-Count": String(statements.length),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
