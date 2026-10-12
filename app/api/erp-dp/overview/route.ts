import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability, hasCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";
import { companyScopeClause } from "@/lib/erp-dp-service";

/**
 * ERP DP — painel de entrada do modo ERP.
 *
 * Quatro números que o DP olha antes de qualquer outra coisa, no vocabulário
 * da engenharia reversa do SAP: o quadro de hoje, as medidas aprovadas
 * esperando execução (PA40), os retroativos abertos (0003), os prazos
 * contratuais (0019) e as competências em andamento (PA03). Cada contagem
 * respeita o escopo de empresa.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const companyId = cleanText(new URL(request.url).searchParams.get("companyId"), 120);
    const empty = { active: 0, onLeave: 0, terminated: 0, approvedMovements: 0, openRetroactive: 0, contractDeadlines: 0, cycles: [] };
    const scope = await companyScopeClause(d1, workspace.id, user.id, workspace.role, companyId, "company_id");
    if (!scope) return Response.json(empty);

    const staff = await d1.prepare(`SELECT
        count(*) FILTER (WHERE employment_status = 'active')::int AS active,
        count(*) FILTER (WHERE employment_status = 'on_leave')::int AS on_leave,
        count(*) FILTER (WHERE employment_status = 'terminated')::int AS terminated
      FROM fdp_employees WHERE workspace_id = ? AND ${scope.clause}`).bind(workspace.id, ...scope.values)
      .first<{ active: number; on_leave: number; terminated: number }>();
    const approved = hasCapability(workspace, "movements.read")
      ? await d1.prepare(`SELECT count(*)::int AS total FROM fdp_employee_movements WHERE workspace_id = ? AND status = 'approved' AND ${scope.clause}`)
        .bind(workspace.id, ...scope.values).first<{ total: number }>()
      : null;
    const retro = hasCapability(workspace, "movements.read")
      ? await d1.prepare(`SELECT count(*)::int AS total FROM fdp_erp_retroactive_items
          WHERE workspace_id = ? AND status = 'open' AND ${scope.clause}`)
        .bind(workspace.id, ...scope.values).first<{ total: number }>()
      : null;
    // Prazos contratuais vencidos ou nos próximos 15 dias — a mesma janela que
    // a tela de Prazos contratuais usa para "precisa de decisão agora".
    const contracts = await d1.prepare(`SELECT count(*)::int AS total FROM fdp_employee_contract_terms ct
        JOIN fdp_employees e ON e.workspace_id = ct.workspace_id AND e.id = ct.employee_id
        WHERE ct.workspace_id = ? AND e.employment_status <> 'terminated' AND ${scope.clause.replaceAll("company_id", "e.company_id")}
          AND ((ct.experience_first_end IS NOT NULL AND ct.experience_first_end >= CURRENT_DATE AND ct.experience_first_end <= CURRENT_DATE + 15)
            OR (ct.contract_end IS NOT NULL AND ct.contract_end <= CURRENT_DATE + 15)
            OR (ct.notice_end IS NOT NULL AND ct.notice_end <= CURRENT_DATE + 15))`)
      .bind(workspace.id, ...scope.values).first<{ total: number }>();
    const cycles = hasCapability(workspace, "competences.read")
      ? (await d1.prepare(`SELECT c.id, c.company_id, COALESCE(NULLIF(co.trade_name, ''), co.legal_name) AS company_name, c.competence, c.status, c.payment_date
          FROM fdp_payroll_cycles c JOIN fdp_companies co ON co.workspace_id = c.workspace_id AND co.id = c.company_id
          WHERE c.workspace_id = ? AND ${scope.clause.replaceAll("company_id", "c.company_id")}
          ORDER BY c.competence DESC, company_name LIMIT 24`).bind(workspace.id, ...scope.values).all<Record<string, unknown>>()).results
      : [];

    return Response.json({
      active: staff?.active ?? 0, onLeave: staff?.on_leave ?? 0, terminated: staff?.terminated ?? 0,
      approvedMovements: approved?.total ?? 0, openRetroactive: retro?.total ?? 0, contractDeadlines: contracts?.total ?? 0, cycles,
    });
  } catch (error) { return apiError(error); }
}
