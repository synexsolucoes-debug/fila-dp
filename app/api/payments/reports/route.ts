import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";

const reports = {
  "psychology-by-psychologist": {
    capability: "psychology.payments.read",
    columns: ["psicologo", "competencia", "consultas", "colaboradores", "bruto", "ajustes", "liquido", "status", "pagamento"],
    query: `SELECT a.legal_name AS psicologo, c.competence AS competencia, c.sessions_count AS consultas, c.employees_count AS colaboradores,
        c.gross_amount AS bruto, c.adjustments_amount AS ajustes, c.net_amount AS liquido, c.status, coalesce(p.status, 'sem_registro') AS pagamento
      FROM fdp_psychology_closings c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      LEFT JOIN fdp_psychology_payments p ON p.workspace_id = c.workspace_id AND p.closing_id = c.id
      WHERE c.workspace_id = ? AND c.competence = ?`,
    companyColumn: "c.company_id",
    order: "ORDER BY a.legal_name",
  },
  "psychology-by-employee": {
    capability: "psychology.payments.read",
    columns: ["colaborador", "matricula", "psicologo", "competencia", "consultas", "valor"],
    query: `SELECT e.full_name AS colaborador, e.registration_number AS matricula, a.legal_name AS psicologo, s.competence AS competencia,
        sum(s.session_quantity)::int AS consultas, sum(s.total_amount) AS valor
      FROM fdp_psychology_sessions s
      JOIN fdp_employees e ON e.workspace_id = s.workspace_id AND e.id = s.employee_id
      JOIN fdp_auxiliary_providers a ON a.workspace_id = s.workspace_id AND a.id = s.provider_id
      WHERE s.workspace_id = ? AND s.competence = ? AND s.status = 'registered'`,
    companyColumn: "s.company_id",
    order: "GROUP BY e.full_name, e.registration_number, a.legal_name, s.competence ORDER BY e.full_name",
  },
  "contractor-closing": {
    capability: "contractors.payments.read",
    columns: ["prestador", "competencia", "base", "creditos", "descontos", "liquido", "limite_nf", "nf_esperada", "complemento", "caju",
      "nf_recebida", "status_nf", "status_caju", "conciliacao", "diferenca", "status"],
    query: `SELECT a.legal_name AS prestador, c.competence AS competencia, c.base_amount AS base, c.credits_amount AS creditos,
        c.debits_amount AS descontos, c.net_amount AS liquido, c.invoice_limit_amount AS limite_nf, c.invoice_expected_amount AS nf_esperada,
        c.complement_amount AS complemento, c.caju_amount AS caju, c.invoice_received_amount AS nf_recebida, c.invoice_status AS status_nf,
        c.caju_status AS status_caju, c.reconciliation_status AS conciliacao, c.reconciliation_difference AS diferenca, c.status
      FROM fdp_contractor_closings c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      WHERE c.workspace_id = ? AND c.competence = ?`,
    companyColumn: "c.company_id",
    order: "ORDER BY a.legal_name",
  },
  "contractor-divergences": {
    capability: "contractors.payments.read",
    columns: ["prestador", "competencia", "liquido", "nf_esperada", "nf_recebida", "complemento", "complemento_pago", "diferenca", "conciliacao"],
    query: `SELECT a.legal_name AS prestador, c.competence AS competencia, c.net_amount AS liquido, c.invoice_expected_amount AS nf_esperada,
        c.invoice_received_amount AS nf_recebida, c.complement_amount AS complemento, c.complement_paid_amount AS complemento_pago,
        c.reconciliation_difference AS diferenca, c.reconciliation_status AS conciliacao
      FROM fdp_contractor_closings c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      WHERE c.workspace_id = ? AND c.competence = ? AND (c.reconciliation_status = 'divergent' OR c.invoice_status = 'divergent')`,
    companyColumn: "c.company_id",
    order: "ORDER BY a.legal_name",
  },
} as const;

type ReportKey = keyof typeof reports;

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
    const key = cleanText(url.searchParams.get("report"), 60) as ReportKey;
    const report = reports[key];
    if (!report) throw ApiError.notFound("Relatório não encontrado.", "PAYMENT_REPORT_NOT_FOUND");
    requireCapability(workspace.role, report.capability);

    const competence = validCompetence(url.searchParams.get("competence"));
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const format = url.searchParams.get("format") === "csv" ? "csv" : "json";

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ report: key, competence, rows: [] });
    const filters: string[] = [];
    const values: unknown[] = [workspace.id, competence];
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
