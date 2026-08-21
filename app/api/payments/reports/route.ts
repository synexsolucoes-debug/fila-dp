import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";
import { reports, type PaymentReportKey } from "@/lib/payment-reports";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",;\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** Relatórios reais dos módulos de pagamento, em JSON ou CSV, com escopo de empresa e auditoria de exportação. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const key = cleanText(url.searchParams.get("report"), 60) as PaymentReportKey;
    const report = reports[key];
    if (!report) throw ApiError.notFound("Relatório não encontrado.", "PAYMENT_REPORT_NOT_FOUND");
    requireCapability(workspace, report.capability);

    const competence = validCompetence(url.searchParams.get("competence"));
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const format = url.searchParams.get("format") === "csv" ? "csv" : "json";

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ report: key, competence, rows: [] });
    const filters: string[] = [];
    /* Quase todo relatório cita grupo e competência uma vez. O extrato
       analítico é uma união — a base da apuração de um lado, os lançamentos do
       outro — e cita os dois em cada lado. O par repetido vai aqui, e não numa
       segunda rota, porque o resto do caminho é idêntico: mesma permissão,
       mesmo recorte por empresa, mesma auditoria de exportação. */
    const parameterPairs = "paramPairs" in report ? report.paramPairs : 1;
    const values: unknown[] = Array.from({ length: parameterPairs }, () => [workspace.id, competence]).flat();
    if (companyId) {
      if (!access.unrestricted && !access.companyIds.has(companyId)) throw ApiError.forbidden("Você não tem acesso a esta empresa.", "COMPANY_ACCESS_REQUIRED");
      filters.push(`${report.companyColumn} = ?`);
      values.push(companyId);
    } else if (!access.unrestricted) {
      const ids = [...access.companyIds];
      filters.push(`${report.companyColumn} IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }

    const sql = `${report.query}${filters.length ? ` AND ${filters.join(" AND ")}` : ""} ${report.order}`;
    const rows = await d1.prepare(sql).bind(...values).all<Record<string, unknown>>();

    if (format === "csv") {
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "payment_report.exported", entityType: "payment_report", entityId: key,
        metadata: { competence, companyId: companyId || "all", rowCount: rows.results.length, format },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      const header = report.columns.join(";");
      const body = rows.results.map((row) => report.columns.map((column) => csvCell(row[column])).join(";")).join("\n");
      return new Response(`${header}\n${body}\n`, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${key}-${competence}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return Response.json({ report: key, competence, columns: report.columns, rows: rows.results });
  } catch (error) {
    return apiError(error);
  }
}
