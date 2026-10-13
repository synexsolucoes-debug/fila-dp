import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { accountingCsv, accountingEntries, s1200Csv, salaryDueDate } from "@/lib/payroll-obligations";
import { cnab240Salaries } from "@/lib/cnab240";
import { runForObligations } from "@/lib/payroll-exports-service";
import { bankAccountFromRow } from "@/lib/payroll-settings-service";

type RouteContext = { params: Promise<{ id: string }> };

const kinds = ["cnab", "s1200", "accounting"] as const;

/**
 * Arquivos da folha fechada (§4.35): pagamento em CNAB 240, rubricas no
 * formato do S-1200 e lançamentos contábeis. Só folha fechada: arquivo de
 * pagamento de folha que ainda pode mudar é pagamento errado.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const kind = kinds.find((item) => item === url.searchParams.get("kind"));
    if (!kind) throw ApiError.badRequest("Escolha o arquivo: cnab, s1200 ou accounting.", "EXPORT_KIND_INVALID");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.manage");
    const { run, results, settings, company } = await runForObligations(d1, workspace, user.id, id);
    if (run.status !== "closed") throw ApiError.badRequest("Feche a folha antes de gerar os arquivos.", "PAYROLL_RUN_NOT_CLOSED");

    let body: string;
    let filename: string;
    let contentType = "text/csv; charset=utf-8";
    let detail: Record<string, unknown> = {};
    if (kind === "cnab") {
      if (!settings.bank) throw ApiError.badRequest("Cadastre o banco e o convênio da empresa na configuração da folha.", "CNAB_COMPANY_BANK_MISSING");
      const rows = await d1.prepare(`SELECT * FROM fdp_employee_bank_accounts WHERE workspace_id = ? AND employee_id IN (
          SELECT employee_id FROM fdp_payroll_results WHERE workspace_id = ? AND run_id = ?)`).bind(workspace.id, workspace.id, run.id).all<Record<string, unknown>>();
      const accounts = new Map((rows.results ?? []).map((row) => [String(row.employee_id), bankAccountFromRow(row)]));
      const payable = results.filter((result) => accounts.has(result.employeeId) && result.netCents > 0);
      const missing = results.filter((result) => !accounts.has(result.employeeId)).map((result) => result.registrationNumber);
      const paymentDate = url.searchParams.get("paymentDate") ?? salaryDueDate(run.competence);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(paymentDate)) throw ApiError.badRequest("Data de pagamento inválida.", "CNAB_DATE_INVALID");
      const sequence = Number((await d1.prepare("SELECT COUNT(*) AS total FROM fdp_audit_events WHERE workspace_id = ? AND action = 'payroll.export.cnab'")
        .bind(workspace.id).first<{ total: number }>())?.total ?? 0) + 1;
      try {
        const file = cnab240Salaries({
          company: { name: company.name, taxId: company.taxId, bank: settings.bank }, paymentDate, generatedAt: new Date(), sequence,
          payments: payable.map((result) => {
            const account = accounts.get(result.employeeId)!;
            return { name: result.name, bankCode: account.bankCode, agency: account.agency, agencyDigit: account.agencyDigit, account: account.account,
              accountDigit: account.accountDigit, amountCents: result.netCents, reference: `${run.competence}-${result.registrationNumber}` };
          }),
        });
        body = file.content;
        detail = { payments: file.count, totalCents: file.totalCents, missing, paymentDate };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code) throw ApiError.badRequest((error as Error).message, code);
        throw error;
      }
      filename = `cnab240-salarios-${run.competence}.rem`;
      contentType = "text/plain; charset=us-ascii";
    } else if (kind === "s1200") {
      body = s1200Csv(run.competence, results);
      filename = `rubricas-s1200-${run.competence}.csv`;
      detail = { employees: results.length };
    } else {
      const entries = accountingEntries(run.competence, results, settings);
      body = accountingCsv(entries);
      filename = `lancamentos-folha-${run.competence}.csv`;
      detail = { entries: entries.length };
    }
    await d1.batch([prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `payroll.export.${kind}`, entityType: "payroll_run", entityId: run.id,
      before: null, after: { competence: run.competence, ...detail },
      metadata: { scope: "company", companyId: run.companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
    })]);
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(kind === "cnab" && Array.isArray(detail.missing) && detail.missing.length ? { "X-Vinculato-Missing-Accounts": String(detail.missing.length) } : {}),
      },
    });
  } catch (error) { return apiError(error); }
}
