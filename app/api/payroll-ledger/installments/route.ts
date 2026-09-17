import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/clean-text";
import { isCompetence, ledgerCategories, ledgerInstallmentStatuses } from "@/lib/payroll-ledger";
import { MAX_LEDGER_RECORDS, ledgerInstallmentFromRow } from "@/lib/payroll-ledger-service";

/**
 * As parcelas de uma competência — a tela de conferência do mês.
 *
 * Sem filtro de competência a rota devolve tudo o que está em aberto, ordenado
 * pela competência mais antiga: é a pergunta "o que ficou para trás", que é a
 * que some numa planilha com uma aba por mês.
 *
 * `atrasadas=true` recorta as parcelas de competências **anteriores** à
 * informada que continuam sem confirmação. Elas não somem do mês em que
 * nasceram nem migram sozinhas para o mês seguinte — só aparecem aqui, para
 * alguém decidir o que fazer com elas.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.read", "consultar as parcelas e saldos");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const conditions = ["installment.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      if (ids.length) { conditions.push(`installment.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
      else conditions.push("false");
    }
    if (companyId) { conditions.push("installment.company_id = ?"); values.push(companyId); }

    const competence = cleanText(url.searchParams.get("competence"), 7);
    const overdue = url.searchParams.get("overdue") === "true";
    if (isCompetence(competence)) {
      if (overdue) {
        /* Parcela atrasada é a de competência anterior que segue sem confirmação
           integral. Ela continua pertencendo ao mês dela — o `<` aqui é leitura,
           não migração. */
        conditions.push("installment.competence < ?"); values.push(competence);
        conditions.push("installment.discounted_amount < installment.planned_amount");
        conditions.push("installment.status NOT IN ('canceled', 'rescheduled', 'skipped')");
      } else {
        conditions.push("installment.competence = ?"); values.push(competence);
      }
    }

    const entryId = cleanText(url.searchParams.get("entryId"), 120);
    if (entryId) { conditions.push("installment.entry_id = ?"); values.push(entryId); }
    const employeeId = cleanText(url.searchParams.get("employeeId"), 120);
    if (employeeId) { conditions.push("entry.employee_id = ?"); values.push(employeeId); }
    const category = cleanText(url.searchParams.get("category"), 40);
    if (ledgerCategories.includes(category as never)) { conditions.push("entry.category = ?"); values.push(category); }
    const status = cleanText(url.searchParams.get("status"), 40);
    if (ledgerInstallmentStatuses.includes(status as never)) { conditions.push("installment.status = ?"); values.push(status); }
    const target = cleanText(url.searchParams.get("settlementTarget"), 40);
    if (target === "payroll" || target === "contractor_payment" || target === "other") {
      conditions.push("entry.settlement_target = ?"); values.push(target);
    }

    /* Só o que está autorizado entra na conferência. Um lançamento em rascunho
       ou aguardando aprovação tem parcelas programadas, mas elas não podem ser
       confirmadas — e listá-las junto convidaria alguém a tentar. */
    if (url.searchParams.get("all") !== "true") {
      conditions.push("entry.status IN ('approved', 'active', 'suspended')");
    }

    const result = await d1.prepare(`SELECT installment.*,
        entry.title AS entry_title, entry.category, entry.settlement_target,
        entry.status AS entry_status, entry.employee_id, entry.unit_label, entry.department_label,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name,
        employee.full_name AS employee_name,
        provider.legal_name AS provider_name
      FROM fdp_ledger_installments installment
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
      JOIN fdp_companies company
        ON company.workspace_id = installment.workspace_id AND company.id = installment.company_id
      LEFT JOIN fdp_employees employee
        ON employee.workspace_id = entry.workspace_id AND employee.id = entry.employee_id
      LEFT JOIN fdp_auxiliary_providers provider
        ON provider.workspace_id = entry.workspace_id AND provider.id = entry.provider_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY installment.competence, employee.full_name, installment.number
      LIMIT ?`).bind(...values, MAX_LEDGER_RECORDS + 1).all<Record<string, unknown>>();

    const rows = result.results.slice(0, MAX_LEDGER_RECORDS);
    return Response.json({
      installments: rows.map(ledgerInstallmentFromRow),
      truncated: result.results.length > MAX_LEDGER_RECORDS,
      limit: MAX_LEDGER_RECORDS,
    });
  } catch (error) { return apiError(error); }
}
