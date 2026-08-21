import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";
import { reports, type PaymentReportKey } from "@/lib/payment-reports";
import { renderContractorStatement } from "@/lib/contractor-statement-pdf";
import { buildStatement } from "@/lib/contractor-statement";
import { buildInvoiceNoticeFile } from "@/lib/contractor-invoice-notice";

/** Toda exportação entra na auditoria, em qualquer formato: é ela que responde
 *  quem levou os valores de uma competência para fora do sistema. */
function recordExport(
  request: Request, workspaceId: string, userId: string, email: string,
  key: string, competence: string, companyId: string, rowCount: number, format: string,
) {
  return prepareAuditEvent({
    workspaceId, actorUserId: userId, actorEmail: email,
    action: "payment_report.exported", entityType: "payment_report", entityId: key,
    metadata: { competence, companyId: companyId || "all", rowCount, format },
    requestId: request.headers.get("x-fila-dp-request-id"),
  }).run();
}

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
    const requested = url.searchParams.get("format");
    const format = requested === "csv" ? "csv"
      : requested === "pdf" ? "pdf"
        : requested === "txt" ? "txt" : "json";
    /* O PDF existe para um documento só: o extrato analítico, que é o que se
       entrega para conferência. Oferecê-lo nos outros seria prometer um
       desenho que não existe. */
    if (format === "pdf" && key !== "contractor-analytical") {
      throw ApiError.badRequest("Este relatório não tem versão em PDF.", "PAYMENT_REPORT_NO_PDF");
    }
    /* O texto puro só faz sentido para o aviso de nota: é uma mensagem pronta
       por prestador, não uma tabela. */
    if (format === "txt" && key !== "contractor-invoice-notice") {
      throw ApiError.badRequest("Este relatório não tem versão em texto.", "PAYMENT_REPORT_NO_TXT");
    }

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
    /* Na maioria dos relatórios a empresa recorta a lista. No aviso de nota ela
       é a emitente: uma escolha só, que vale para todos os prestadores do
       grupo. O acesso à empresa é exigido nos dois casos — é ela que aparece
       no documento —, o que muda é se ela entra no WHERE. */
    const companyIsIssuer = "companyMeaning" in report && report.companyMeaning === "issuer";
    if (companyId) {
      if (!access.unrestricted && !access.companyIds.has(companyId)) throw ApiError.forbidden("Você não tem acesso a esta empresa.", "COMPANY_ACCESS_REQUIRED");
      if (!companyIsIssuer) {
        filters.push(`${report.companyColumn} = ?`);
        values.push(companyId);
      } else if (!access.unrestricted) {
        const ids = [...access.companyIds];
        filters.push(`${report.companyColumn} IN (${ids.map(() => "?").join(",")})`);
        values.push(...ids);
      }
    } else if (!access.unrestricted) {
      const ids = [...access.companyIds];
      filters.push(`${report.companyColumn} IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }

    const sql = `${report.query}${filters.length ? ` AND ${filters.join(" AND ")}` : ""} ${report.order}`;
    const rows = await d1.prepare(sql).bind(...values).all<Record<string, unknown>>();

    if (format === "txt") {
      /* A emitente vai no texto de cada mensagem: é o dado que quem recebe
         precisa para emitir, e o único que ela não consegue conferir sozinha. */
      const emitente = companyId
        ? await d1.prepare("SELECT legal_name, trade_name FROM fdp_companies WHERE workspace_id = ? AND id = ?")
          .bind(workspace.id, companyId).first<{ legal_name: string; trade_name: string }>()
        : null;
      const conteudo = buildInvoiceNoticeFile(rows.results, emitente?.trade_name || emitente?.legal_name || "");
      /* Arquivo vazio parece defeito. Se ninguém tem valor a emitir, a recusa
         diz isso — que é uma informação, e não um erro. */
      if (!conteudo) {
        throw ApiError.badRequest(
          "Nenhum prestador do grupo tem valor de nota a emitir nesta competência.",
          "INVOICE_NOTICE_EMPTY",
        );
      }
      await recordExport(request, workspace.id, user.id, auth.user.email, key, competence, companyId, rows.results.length, "txt");
      return new Response(`\uFEFF${conteudo}\r\n`, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="avisos-nf-${competence}.txt"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (format === "pdf") {
      const empresa = companyId
        ? await d1.prepare("SELECT legal_name, trade_name, tax_id FROM fdp_companies WHERE workspace_id = ? AND id = ?")
          .bind(workspace.id, companyId).first<{ legal_name: string; trade_name: string; tax_id: string }>()
        : null;
      await recordExport(request, workspace.id, user.id, auth.user.email, key, competence, companyId, rows.results.length, "pdf");
      const pdf = renderContractorStatement(buildStatement(rows.results, {
        competence,
        empresa: empresa?.trade_name || empresa?.legal_name || workspace.name || "Todas as empresas do grupo",
        cnpjEmpresa: empresa?.tax_id ?? "",
        emitidoPor: user.name || auth.user.email,
      }));
      return new Response(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="extrato-analitico-pj-${competence}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (format === "csv") {
      await recordExport(request, workspace.id, user.id, auth.user.email, key, competence, companyId, rows.results.length, "csv");
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
