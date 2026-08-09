import { getD1 } from "@/db";
import { apiV1Error, apiV1Response, authenticateApiRequest, paginationFrom, requireScope } from "@/lib/api-v1";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/contractor-closings — apuração PJ da competência.
 *
 * É a resposta programática às perguntas do produto: quanto o prestador recebe,
 * quanto deve emitir de nota e quanto vai para o meio complementar.
 */
export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const d1 = getD1();
    const context = await authenticateApiRequest(d1, request);
    requestId = context.requestId;
    requireScope(context, "payments.read");
    const url = new URL(request.url);
    const { limit, cursor } = paginationFrom(url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const competence = cleanText(url.searchParams.get("competence"), 7);
    const status = cleanText(url.searchParams.get("status"), 30);

    const where = ["k.workspace_id = ?"];
    const values: unknown[] = [context.workspaceId];
    if (companyId) { where.push("k.company_id = ?"); values.push(companyId); }
    if (/^\d{4}-\d{2}$/u.test(competence)) { where.push("k.competence = ?"); values.push(competence); }
    if (status) { where.push("k.status = ?"); values.push(status); }
    if (cursor) { where.push("k.id > ?"); values.push(cursor); }

    const rows = await d1.prepare(`SELECT k.id, k.company_id, k.provider_id, k.competence, k.base_amount, k.credits_amount,
        k.debits_amount, k.net_amount, k.invoice_limit_amount, k.invoice_limit_source, k.invoice_expected_amount,
        k.complement_amount, k.complement_method, k.caju_amount, k.status, k.invoice_number, k.invoice_received_amount,
        k.invoice_status, k.caju_status, k.reconciliation_status, k.reconciliation_difference, k.calc_version, k.updated_at,
        a.legal_name AS provider_name
      FROM fdp_contractor_closings k
      JOIN fdp_auxiliary_providers a ON a.workspace_id = k.workspace_id AND a.id = k.provider_id
      WHERE ${where.join(" AND ")} ORDER BY k.id LIMIT ?`)
      .bind(...values, limit + 1).all<Record<string, unknown>>();

    const page = rows.results.slice(0, limit);
    return apiV1Response(context, {
      data: page.map((row) => ({
        id: String(row.id),
        companyId: String(row.company_id),
        contractor: { id: String(row.provider_id), name: String(row.provider_name ?? "") },
        competence: String(row.competence),
        status: String(row.status),
        amounts: {
          base: Number(row.base_amount),
          credits: Number(row.credits_amount),
          debits: Number(row.debits_amount),
          net: Number(row.net_amount),
          invoiceExpected: Number(row.invoice_expected_amount),
          complement: Number(row.complement_amount),
          complementOnBenefitCard: Number(row.caju_amount),
        },
        invoiceLimit: {
          amount: row.invoice_limit_amount === null ? null : Number(row.invoice_limit_amount),
          source: String(row.invoice_limit_source),
        },
        invoice: {
          number: String(row.invoice_number ?? ""),
          receivedAmount: Number(row.invoice_received_amount),
          status: String(row.invoice_status),
        },
        complement: { method: String(row.complement_method), status: String(row.caju_status) },
        reconciliation: { status: String(row.reconciliation_status), difference: Number(row.reconciliation_difference) },
        calcVersion: String(row.calc_version),
        updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
      })),
      nextCursor: rows.results.length > limit ? String(page.at(-1)?.id) : null,
    });
  } catch (error) {
    return apiV1Error(error, requestId);
  }
}
