import { getD1 } from "@/db";
import { apiV1Error, apiV1Response, authenticateApiRequest, paginationFrom, requireScope } from "@/lib/api-v1";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

/** GET /api/v1/competences — competências e seu estado de fechamento. */
export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const d1 = getD1();
    const context = await authenticateApiRequest(d1, request);
    requestId = context.requestId;
    requireScope(context, "competences.read");
    const url = new URL(request.url);
    const { limit, cursor } = paginationFrom(url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const competence = cleanText(url.searchParams.get("competence"), 7);

    const where = ["workspace_id = ?"];
    const values: unknown[] = [context.workspaceId];
    if (companyId) { where.push("company_id = ?"); values.push(companyId); }
    if (/^\d{4}-\d{2}$/u.test(competence)) { where.push("competence = ?"); values.push(competence); }
    if (cursor) { where.push("id > ?"); values.push(cursor); }

    const rows = await d1.prepare(`SELECT id, company_id, competence, status, payment_date, closed_at, updated_at
      FROM fdp_payroll_cycles WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`)
      .bind(...values, limit + 1).all<Record<string, unknown>>();

    const page = rows.results.slice(0, limit);
    return apiV1Response(context, {
      data: page.map((row) => ({
        id: String(row.id),
        companyId: String(row.company_id),
        competence: String(row.competence),
        status: String(row.status),
        paymentDate: row.payment_date ? String(row.payment_date) : null,
        closedAt: row.closed_at ? new Date(String(row.closed_at)).toISOString() : null,
      })),
      nextCursor: rows.results.length > limit ? String(page.at(-1)?.id) : null,
    });
  } catch (error) {
    return apiV1Error(error, requestId);
  }
}
