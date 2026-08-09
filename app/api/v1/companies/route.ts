import { getD1 } from "@/db";
import { apiV1Error, apiV1Response, authenticateApiRequest, paginationFrom, requireScope } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** GET /api/v1/companies — empresas do workspace da chave, paginadas por cursor. */
export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const d1 = getD1();
    const context = await authenticateApiRequest(d1, request);
    requestId = context.requestId;
    requireScope(context, "companies.read");
    const { limit, cursor } = paginationFrom(new URL(request.url));

    const where = ["workspace_id = ?"];
    const values: unknown[] = [context.workspaceId];
    if (cursor) { where.push("id > ?"); values.push(cursor); }
    const rows = await d1.prepare(`SELECT id, legal_name, trade_name, tax_id, status, created_at
      FROM fdp_companies WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`)
      .bind(...values, limit + 1).all<Record<string, unknown>>();

    const page = rows.results.slice(0, limit);
    return apiV1Response(context, {
      data: page.map((row) => ({
        id: String(row.id),
        legalName: String(row.legal_name),
        tradeName: String(row.trade_name ?? ""),
        taxId: String(row.tax_id ?? ""),
        status: String(row.status ?? ""),
        createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
      })),
      nextCursor: rows.results.length > limit ? String(page.at(-1)?.id) : null,
    });
  } catch (error) {
    return apiV1Error(error, requestId);
  }
}
