import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { buildEpiCompliance, type EpiComplianceEmployeeInput, type EpiHoldingInput, type EpiRequirementInput } from "@/lib/epi-compliance";

const asText = (value: unknown) => value == null ? "" : String(value);
const asNumber = (value: unknown) => Number(value) || 0;

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "reports.read");
    const companyAccess = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const url = new URL(request.url);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to")! : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    // Recorte de empresa da barra superior (§34).
    //
    // O escopo de acesso do membro sempre foi respeitado — é segurança. O que
    // faltava era o *filtro*: quem escolhia uma empresa no alto da tela via os
    // números do grupo inteiro em Relatórios, sem nada dizendo isso.
    const companyId = (url.searchParams.get("companyId") ?? "").trim().slice(0, 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    /* Command Center, passo 1 (§4.19): o mesmo escopo por empresa que
       `noEscopo` aplica em memória para cards/hrMetrics, mas em SQL de
       verdade — as quatro consultas de saúde/conformidade abaixo são só
       contagem, e trazer a tabela inteira para filtrar depois seria o N+1 que
       a Central de Trabalho já evita (§12). `ANY(?::text[])` é o mesmo
       primitivo já usado em app/api/payments/contractors/invoices/
       portal-links/route.ts — genuinamente parametrizado, sem montar
       fragmento de SQL em string: uma consulta com `${...}` sai da faixa que
       `verify:sql` consegue preparar contra o schema real e cai na contagem
       de "não verificada", que tem teto. */
    const companyIds = companyId ? [companyId] : [...companyAccess.companyIds];
    const companyUnrestricted = !companyId && companyAccess.unrestricted;

    const today = new Date().toISOString().slice(0, 10);
    const [cards, hrMetrics, overdueExams, overdueTrainings, accidentsInPeriod, catPending, overdueObligations, epiEmployeeRows, epiRequirementRows, epiHoldingRows] = await Promise.all([
      d1.prepare(`SELECT c.id, c.title, c.process_type, c.priority, c.created_at, c.updated_at, c.sla_status, c.archived, c.company_id,
      COALESCE(c.assignee_name, '') AS assignee_name
      FROM fdp_cards c JOIN fdp_boards b ON b.id = c.board_id
      WHERE b.workspace_id = ? AND date(c.created_at) BETWEEN date(?) AND date(?)`).bind(workspace.id, from, to).all<Record<string, unknown>>(),
      d1.prepare(`SELECT m.period, m.headcount, m.admissions, m.terminations, m.payroll_cost, m.company_id, COALESCE(c.legal_name, 'Sem empresa') AS company_name
        FROM fdp_hr_metrics m LEFT JOIN fdp_companies c ON c.id = m.company_id
        WHERE m.workspace_id = ? AND m.period BETWEEN ? AND ? ORDER BY m.period`).bind(workspace.id, from.slice(0, 7), to.slice(0, 7)).all<Record<string, unknown>>(),
      d1.prepare(`SELECT count(*)::int AS total FROM fdp_occupational_exams
        WHERE workspace_id = ? AND next_due_date IS NOT NULL AND next_due_date < CURRENT_DATE
          AND (?::boolean OR company_id = ANY(?::text[]))`)
        .bind(workspace.id, companyUnrestricted, companyIds).first<{ total: number }>(),
      d1.prepare(`SELECT count(*)::int AS total FROM fdp_trainings
        WHERE workspace_id = ? AND valid_until IS NOT NULL AND valid_until < CURRENT_DATE
          AND (?::boolean OR company_id = ANY(?::text[]))`)
        .bind(workspace.id, companyUnrestricted, companyIds).first<{ total: number }>(),
      d1.prepare(`SELECT count(*)::int AS total FROM fdp_work_accidents
        WHERE workspace_id = ? AND occurred_on BETWEEN ? AND ?
          AND (?::boolean OR company_id = ANY(?::text[]))`)
        .bind(workspace.id, from, to, companyUnrestricted, companyIds).first<{ total: number }>(),
      // CAT pendente é estado atual, não recorte de período — a mesma condição
      // de `cat_pending` na Central de Trabalho (lib/work-items.ts, §4.13).
      d1.prepare(`SELECT count(*)::int AS total FROM fdp_work_accidents
        WHERE workspace_id = ? AND cat_issued = 0 AND leave_days > 0
          AND (?::boolean OR company_id = ANY(?::text[]))`)
        .bind(workspace.id, companyUnrestricted, companyIds).first<{ total: number }>(),
      // Mesmo vocabulário de status que a fonte "compliance_obligation" da
      // Central de Trabalho usa (lib/work-items.ts) — vencida é a mesma coisa
      // aqui e lá: aberta/em andamento/bloqueada com prazo já passado.
      d1.prepare(`SELECT count(*)::int AS total FROM fdp_compliance_obligations
        WHERE workspace_id = ? AND status IN ('open', 'in_progress', 'blocked') AND due_date < CURRENT_DATE
          AND (?::boolean OR company_id = ANY(?::text[]))`)
        .bind(workspace.id, companyUnrestricted, companyIds).first<{ total: number }>(),
      // Taxa de conformidade de EPI (§4.19, passo 2): reaproveita o mesmo motor
      // puro que o dashboard de EPI usa por empresa (lib/epi-compliance.ts),
      // só que alimentado com colaborador/regra/saldo do recorte inteiro numa
      // única passada — `buildEpiCompliance` já casa cada regra pela empresa
      // do colaborador (`applies()`), então uma consulta por tabela basta;
      // não é preciso um laço de uma consulta por empresa (N+1).
      d1.prepare(`SELECT e.id, e.company_id, e.department_id, e.position_id, e.establishment_id
        FROM fdp_employees e
        WHERE e.workspace_id = ? AND e.employment_status = 'active'
          AND (?::boolean OR e.company_id = ANY(?::text[]))`)
        .bind(workspace.id, companyUnrestricted, companyIds).all<Record<string, unknown>>(),
      d1.prepare(`SELECT r.id, r.company_id, r.department_id, r.position_id, r.product_id, r.quantity,
          r.replacement_days, r.warning_days, p.ca_number, p.ca_expires_on, p.product_expires_on
        FROM fdp_epi_requirements r
        JOIN fdp_epi_products p ON p.workspace_id = r.workspace_id AND p.id = r.product_id
        WHERE r.workspace_id = ? AND r.active = 1 AND p.status <> 'inactive'
          AND (?::boolean OR r.company_id = ANY(?::text[]))`)
        .bind(workspace.id, companyUnrestricted, companyIds).all<Record<string, unknown>>(),
      d1.prepare(`SELECT d.employee_id, d.product_id,
          SUM(d.quantity - d.settled_quantity) AS quantity, MAX(d.delivered_on) AS last_delivered_on
        FROM fdp_epi_deliveries d
        WHERE d.workspace_id = ? AND d.status <> 'canceled' AND d.quantity > d.settled_quantity
          AND (?::boolean OR d.company_id = ANY(?::text[]))
        GROUP BY d.employee_id, d.product_id`)
        .bind(workspace.id, companyUnrestricted, companyIds).all<Record<string, unknown>>(),
    ]);
    const epiEmployees: EpiComplianceEmployeeInput[] = epiEmployeeRows.results.map((row) => ({
      id: asText(row.id), companyId: asText(row.company_id), name: "", registrationNumber: "",
      departmentId: asText(row.department_id), departmentName: "", positionId: asText(row.position_id),
      positionName: "", establishmentId: asText(row.establishment_id),
    }));
    const epiRequirements: EpiRequirementInput[] = epiRequirementRows.results.map((row) => ({
      id: asText(row.id), companyId: asText(row.company_id), departmentId: asText(row.department_id),
      departmentName: "", positionId: asText(row.position_id), positionName: "",
      establishmentId: "", productId: asText(row.product_id), productName: "", caNumber: asText(row.ca_number),
      caExpiresOn: asText(row.ca_expires_on).slice(0, 10), productExpiresOn: asText(row.product_expires_on).slice(0, 10),
      quantity: asNumber(row.quantity), replacementDays: asNumber(row.replacement_days), warningDays: asNumber(row.warning_days),
    }));
    const epiHoldings: EpiHoldingInput[] = epiHoldingRows.results.map((row) => ({
      employeeId: asText(row.employee_id), productId: asText(row.product_id),
      quantity: asNumber(row.quantity), lastDeliveredOn: asText(row.last_delivered_on).slice(0, 10),
    }));
    const epiCompliance = buildEpiCompliance(epiEmployees, epiRequirements, epiHoldings, today);
    // "Conformidade do grupo" = dos colaboradores com pelo menos uma regra de
    // EPI aplicável, quantos estão em dia — quem não tem regra nenhuma
    // (`unconfigured`) fica fora da conta, porque não é "descumprindo", é
    // "sem regra cadastrada ainda", uma situação diferente que inflaria ou
    // esvaziaria a taxa sem dizer nada sobre conformidade real.
    const epiWithRequirement = epiCompliance.filter((item) => item.status !== "unconfigured");
    const epiCompliant = epiWithRequirement.filter((item) => item.status === "compliant").length;
    const epiComplianceRate = epiWithRequirement.length
      ? Math.round((epiCompliant / epiWithRequirement.length) * 1000) / 10
      : null;
    const noEscopo = (row: Record<string, unknown>) => {
      const empresa = String(row.company_id ?? "");
      if (companyId && empresa !== companyId) return false;
      return companyAccess.unrestricted || companyAccess.companyIds.has(empresa);
    };
    const visibleCards = cards.results.filter(noEscopo);
    const metricRows = hrMetrics.results.filter(noEscopo);
    const activity = await d1.prepare(`SELECT ae.event_type, ae.actor_email, ae.created_at, c.company_id FROM fdp_activity_events ae
      JOIN fdp_cards c ON c.id = ae.card_id WHERE ae.workspace_id = ? AND date(ae.created_at) BETWEEN date(?) AND date(?)`).bind(workspace.id, from, to).all<Record<string, unknown>>();
    const visibleActivity = activity.results.filter(noEscopo);
    const byProcess: Record<string, number> = {};
    const byMember: Record<string, number> = {};
    let completed = 0;
    let totalHours = 0;
    for (const card of visibleCards) {
      const process = String(card.process_type ?? "OUTROS"); byProcess[process] = (byProcess[process] ?? 0) + 1;
      const member = String(card.assignee_name ?? "Sem responsável"); byMember[member] = (byMember[member] ?? 0) + 1;
      if (String(card.sla_status) === "completed" || Boolean(card.archived)) { completed += 1; totalHours += Math.max(0, (new Date(String(card.updated_at)).getTime() - new Date(String(card.created_at)).getTime()) / 3600000); }
    }
    const admissions = metricRows.reduce((sum, row) => sum + Number(row.admissions ?? 0), 0);
    const terminations = metricRows.reduce((sum, row) => sum + Number(row.terminations ?? 0), 0);
    const headcountTotal = metricRows.reduce((sum, row) => sum + Number(row.headcount ?? 0), 0);
    const payrollCostTotal = metricRows.reduce((sum, row) => sum + Number(row.payroll_cost ?? 0), 0);
    const averageHeadcount = metricRows.length ? headcountTotal / metricRows.length : 0;
    const turnoverRate = averageHeadcount ? Math.round((((admissions + terminations) / 2) / averageHeadcount) * 10000) / 100 : 0;
    const payrollByCompany = metricRows.reduce<Record<string, number>>((accumulator, row) => {
      const key = String(row.company_name ?? "Sem empresa");
      accumulator[key] = Math.round(((accumulator[key] ?? 0) + Number(row.payroll_cost ?? 0)) * 100) / 100;
      return accumulator;
    }, {});
    const activityByType = visibleActivity.reduce<Record<string, number>>((accumulator, item) => {
      const key = String(item.event_type);
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});
    return Response.json({
      from,
      to,
      companyId: companyId || null,
      total: visibleCards.length,
      completed,
      completionRate: visibleCards.length ? Math.round((completed / visibleCards.length) * 100) : 100,
      averageCompletionHours: completed ? Math.round((totalHours / completed) * 10) / 10 : 0,
      byProcess,
      byMember,
      activityCount: visibleActivity.length,
      activityByType,
      hrMetrics: {
        periods: metricRows.length,
        admissions,
        terminations,
        averageHeadcount: Math.round(averageHeadcount * 10) / 10,
        payrollCostTotal: Math.round(payrollCostTotal * 100) / 100,
        turnoverRate,
        payrollByCompany,
      },
      safetyMetrics: {
        overdueExams: overdueExams?.total ?? 0,
        overdueTrainings: overdueTrainings?.total ?? 0,
        accidentsInPeriod: accidentsInPeriod?.total ?? 0,
        catPending: catPending?.total ?? 0,
        overdueObligations: overdueObligations?.total ?? 0,
        epiComplianceRate,
      },
    });
  } catch (error) { return apiError(error); }
}
