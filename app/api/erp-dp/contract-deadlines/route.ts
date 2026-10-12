import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";
import { contractDeadlines, contractTermsFromRow } from "@/lib/contract-terms";
import { todayInBrazil } from "@/lib/employee-history";
import { companyScopeClause } from "@/lib/erp-dp-service";

/**
 * ERP DP — prazos contratuais (IT0019 do SAP: tarefas monitoradas).
 *
 * Experiência, prazo determinado e aviso prévio de quem ainda tem vínculo,
 * do vencido até `days` dias à frente (padrão 45). Vencido continua na lista:
 * é o que mais precisa de decisão.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 45, 1), 365);
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, companyId, "e.company_id");
    const today = todayInBrazil();
    if (!scope) return Response.json({ today, items: [] });
    const rows = await d1.prepare(`SELECT t.*, e.id AS employee_id, e.full_name, e.social_name, e.registration_number, e.admission_date,
        COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name
      FROM fdp_employee_contract_terms t
      JOIN fdp_employees e ON e.workspace_id = t.workspace_id AND e.id = t.employee_id
      JOIN fdp_companies co ON co.workspace_id = e.workspace_id AND co.id = e.company_id
      WHERE t.workspace_id = ? AND ${scope.clause} AND e.employment_status <> 'terminated'
        AND (t.contract_end IS NOT NULL OR t.notice_end IS NOT NULL)`)
      .bind(workspace.id, ...scope.values).all<Record<string, unknown>>();
    const limit = new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const items = rows.results.flatMap((row) => contractDeadlines(contractTermsFromRow(row))
      .filter((deadline) => deadline.date <= limit)
      .map((deadline) => ({
        ...deadline,
        employeeId: String(row.employee_id),
        employeeName: String(row.social_name || row.full_name),
        registrationNumber: String(row.registration_number),
        companyName: String(row.company_name),
        overdue: deadline.date < today,
      })))
      .sort((a, b) => a.date.localeCompare(b.date));
    return Response.json({ today, items });
  } catch (error) { return apiError(error); }
}
