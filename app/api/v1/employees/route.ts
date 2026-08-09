import { getD1 } from "@/db";
import { apiV1Error, apiV1Response, authenticateApiRequest, paginationFrom, requireScope } from "@/lib/api-v1";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/employees — colaboradores já admitidos.
 *
 * CPF nunca é exposto: a API devolve apenas os quatro últimos dígitos, como no
 * restante do produto. A admissão digital continua na Sólides.
 */
export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const d1 = getD1();
    const context = await authenticateApiRequest(d1, request);
    requestId = context.requestId;
    requireScope(context, "employees.read");
    const url = new URL(request.url);
    const { limit, cursor } = paginationFrom(url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const status = cleanText(url.searchParams.get("status"), 30);

    const where = ["e.workspace_id = ?"];
    const values: unknown[] = [context.workspaceId];
    if (companyId) { where.push("e.company_id = ?"); values.push(companyId); }
    if (["active", "on_leave", "terminated"].includes(status)) { where.push("e.employment_status = ?"); values.push(status); }
    if (cursor) { where.push("e.id > ?"); values.push(cursor); }

    const rows = await d1.prepare(`SELECT e.id, e.company_id, e.registration_number, e.full_name, e.social_name, e.cpf_last4,
        e.admission_date, e.termination_date, e.employment_status, e.employment_type, e.source_system, e.external_id, e.updated_at
      FROM fdp_employees e WHERE ${where.join(" AND ")} ORDER BY e.id LIMIT ?`)
      .bind(...values, limit + 1).all<Record<string, unknown>>();

    const page = rows.results.slice(0, limit);
    return apiV1Response(context, {
      data: page.map((row) => ({
        id: String(row.id),
        companyId: String(row.company_id),
        registrationNumber: String(row.registration_number),
        fullName: String(row.full_name),
        socialName: String(row.social_name ?? ""),
        cpfLast4: String(row.cpf_last4 ?? ""),
        admissionDate: row.admission_date ? String(row.admission_date) : null,
        terminationDate: row.termination_date ? String(row.termination_date) : null,
        employmentStatus: String(row.employment_status),
        employmentType: String(row.employment_type),
        source: { system: String(row.source_system), externalId: String(row.external_id ?? "") },
        updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
      })),
      nextCursor: rows.results.length > limit ? String(page.at(-1)?.id) : null,
    });
  } catch (error) {
    return apiV1Error(error, requestId);
  }
}
