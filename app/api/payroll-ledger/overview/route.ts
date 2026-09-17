import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/clean-text";

/**
 * O que a tela de Adiantamentos e Descontos precisa antes de desenhar a lista.
 *
 * Empresas que a pessoa enxerga, permissões, competências abertas e os totais
 * do recorte. Os totais vêm daqui, e não somados no navegador a partir da
 * página carregada: a lista é paginada, e um total que só conta o que coube na
 * página é um total errado exibido com a confiança de um total certo.
 *
 * As permissões vão na resposta porque a tela precisa saber quais botões
 * desenhar. Elas não substituem a verificação no servidor — cada rota de
 * escrita confere a sua, e esconder botão nunca foi proteção.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.read", "abrir os adiantamentos e descontos");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const permissions = {
      read: true,
      request: hasCapability(workspace, "ledger.request"),
      manage: hasCapability(workspace, "ledger.manage"),
      approve: hasCapability(workspace, "ledger.approve"),
      pay: hasCapability(workspace, "ledger.pay"),
      confirm: hasCapability(workspace, "ledger.confirm"),
      reverse: hasCapability(workspace, "ledger.reverse"),
      override: hasCapability(workspace, "ledger.override"),
      reschedule: hasCapability(workspace, "ledger.reschedule"),
      import: hasCapability(workspace, "ledger.import"),
      export: hasCapability(workspace, "ledger.export"),
      close: hasCapability(workspace, "ledger.close"),
      reopen: hasCapability(workspace, "ledger.reopen"),
    };

    /* O recorte é montado como condição inteira, e não como fragmento que
       começa em `AND`: `scripts/verify-inline-sql` prepara cada consulta contra
       o schema real substituindo o trecho interpolado. */
    const conditions = ["entry.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      if (ids.length) { conditions.push(`entry.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
      else conditions.push("false");
    }
    if (companyId) { conditions.push("entry.company_id = ?"); values.push(companyId); }
    const scope = conditions.join(" AND ");

    /* Os quatro números do topo. Saem da mesma apuração que a lista usa — o
       previsto de uma parcela cancelada, pulada ou reprogramada sai da conta,
       mas o que já foi descontado nela continua contando. */
    const totals = await d1.prepare(`SELECT
        COUNT(DISTINCT entry.id)::int AS entries,
        COUNT(DISTINCT entry.id) FILTER (WHERE entry.status = 'pending_approval')::int AS awaiting_approval,
        COALESCE(SUM(CASE WHEN installment.status IN ('canceled', 'rescheduled', 'skipped')
          THEN installment.discounted_amount ELSE installment.planned_amount END), 0) AS planned_total,
        COALESCE(SUM(installment.discounted_amount), 0) AS discounted_total
      FROM fdp_ledger_entries entry
      LEFT JOIN fdp_ledger_installments installment
        ON installment.workspace_id = entry.workspace_id AND installment.entry_id = entry.id
      WHERE ${scope} AND entry.status NOT IN ('canceled', 'rejected', 'renegotiated')`)
      .bind(...values).first<Record<string, unknown>>();

    const companyConditions = ["company.workspace_id = ?"]; const companyValues: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      if (ids.length) { companyConditions.push(`company.id IN (${ids.map(() => "?").join(",")})`); companyValues.push(...ids); }
      else companyConditions.push("false");
    }
    const companies = await d1.prepare(`SELECT company.id, company.legal_name, company.trade_name, company.tax_id, company.status
      FROM fdp_companies company
      WHERE ${companyConditions.join(" AND ")}
      ORDER BY company.status, COALESCE(NULLIF(company.trade_name, ''), company.legal_name)`)
      .bind(...companyValues).all<Record<string, unknown>>();

    /* As competências vêm do ciclo de folha que já existe. O módulo não abre
       competência própria: ele confere dentro da que a Operação DP governa. */
    const cycleConditions = ["cycle.workspace_id = ?"]; const cycleValues: unknown[] = [workspace.id];
    if (companyId) { cycleConditions.push("cycle.company_id = ?"); cycleValues.push(companyId); }
    const competences = await d1.prepare(`SELECT cycle.id, cycle.company_id, cycle.competence, cycle.status
      FROM fdp_payroll_cycles cycle
      WHERE ${cycleConditions.join(" AND ")}
      ORDER BY cycle.competence DESC LIMIT 24`)
      .bind(...cycleValues).all<Record<string, unknown>>();

    const areas = await d1.prepare(`SELECT area.id, area.name, area.code
      FROM fdp_areas area
      WHERE area.workspace_id = ? AND area.status = 'active'
      ORDER BY area.name`).bind(workspace.id).all<Record<string, unknown>>();

    const plannedTotal = Number(totals?.planned_total ?? 0);
    const discountedTotal = Number(totals?.discounted_total ?? 0);
    return Response.json({
      permissions,
      companies: companies.results,
      competences: competences.results,
      areas: areas.results,
      summary: {
        entries: Number(totals?.entries ?? 0),
        awaitingApproval: Number(totals?.awaiting_approval ?? 0),
        plannedTotal,
        discountedTotal,
        remainingTotal: Math.max(0, plannedTotal - discountedTotal),
      },
    });
  } catch (error) { return apiError(error); }
}
