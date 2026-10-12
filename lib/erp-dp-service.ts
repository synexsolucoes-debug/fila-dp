import { getCompanyAccessScope, requireCompanyAccess } from "./fila-dp-db";
import type { WorkspaceRole } from "./fila-dp-types";
import { competenceOf, processedCycleStatuses, retroactivityTitle } from "./erp-dp";

/**
 * ERP DP: o recorte de empresa que toda leitura do modo ERP aplica.
 *
 * Mesma regra das listas do produto (`GET /api/operations/movements`):
 * administrador vê o grupo inteiro; os demais, só as empresas liberadas a
 * eles. Com `companyId`, o acesso àquela empresa é exigido antes.
 * `null` quer dizer "nenhuma empresa no escopo" — a rota devolve vazio.
 */
export async function companyScopeClause(
  d1: SqlDatabase, workspaceId: string, userId: string, role: WorkspaceRole, companyId: string, column: string,
): Promise<{ clause: string; values: string[] } | null> {
  if (companyId) {
    await requireCompanyAccess(d1, workspaceId, userId, role, companyId);
    return { clause: `${column} = ?`, values: [companyId] };
  }
  const access = await getCompanyAccessScope(d1, workspaceId, userId, role);
  if (access.unrestricted) return { clause: "TRUE", values: [] };
  const ids = [...access.companyIds];
  if (!ids.length) return null;
  return { clause: `${column} IN (${ids.map(() => "?").join(", ")})`, values: ids };
}

/**
 * Retroatividade (o 0003 do SAP, sem recálculo): se a vigência cai numa
 * competência que já foi processada, devolve a instrução que abre o
 * retroativo do ERP DP — para entrar no mesmo lote da mudança. Idempotente
 * pela origem: reaplicar não abre um segundo.
 *
 * Grava em `fdp_erp_retroactive_items`, e não nas Pendências da Operação DP:
 * o que é ERP fica no ERP (§4.30).
 */
export async function prepareRetroactiveItem(d1: SqlDatabase, input: {
  workspaceId: string; companyId: string; employeeId: string | null;
  sourceType: "movement" | "erp_action"; sourceId: string; effectiveDate: string; title: string;
}): Promise<{ statement: SqlPreparedStatement; competence: string; cycleStatus: string } | null> {
  const competence = competenceOf(input.effectiveDate);
  const cycle = await d1.prepare(`SELECT status FROM fdp_payroll_cycles
    WHERE workspace_id = ? AND company_id = ? AND competence = ? AND status IN (${processedCycleStatuses.map(() => "?").join(", ")})`)
    .bind(input.workspaceId, input.companyId, competence, ...processedCycleStatuses).first<{ status: string }>();
  if (!cycle) return null;
  return {
    competence,
    cycleStatus: cycle.status,
    statement: d1.prepare(`INSERT INTO fdp_erp_retroactive_items
        (id, workspace_id, company_id, employee_id, source_type, source_id, effective_date, competence, cycle_status, title)
      VALUES (?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?)
      ON CONFLICT (workspace_id, source_type, source_id) DO NOTHING`)
      .bind(crypto.randomUUID(), input.workspaceId, input.companyId, input.employeeId, input.sourceType, input.sourceId,
        input.effectiveDate, competence, cycle.status, retroactivityTitle(input.title, competence)),
  };
}
