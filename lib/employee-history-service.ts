import {
  currentValuesFromEmployee, historyRecordFromRow, historyRecordTypes, planHistoryChange,
  type HistoryReason, type HistoryRecordType, type HistoryValues,
} from "./employee-history.ts";

/**
 * Histórico funcional: a parte que precisa de banco.
 *
 * Quem altera o vínculo de alguém (aplicar movimentação, demitir, editar o
 * cadastro) chama `prepareHistoryChange` **antes** do próprio `batch` e junta
 * as instruções devolvidas ao mesmo lote — o histórico entra na mesma
 * transação da mudança, ou não entra nenhum dos dois. Nada aqui grava sozinho.
 *
 * A leitura do cadastro acontece antes do lote de propósito: a linha de base
 * precisa ser o cadastro **antes** da mudança.
 */

export type HistoryChangeInput = {
  workspaceId: string;
  employeeId: string;
  userId: string;
  effectiveDate: string;
  reason: HistoryReason;
  movementId?: string | null;
  changes: Partial<Record<HistoryRecordType, Partial<HistoryValues>>>;
};

function valueBindings(values: HistoryValues) {
  return [values.employmentStatus, values.companyId, values.establishmentId, values.departmentId,
    values.positionId, values.costCenterId, values.workScheduleId];
}

export async function prepareHistoryChange(d1: SqlDatabase, input: HistoryChangeInput): Promise<SqlPreparedStatement[]> {
  const employee = await d1.prepare(`SELECT employment_status, company_id, establishment_id, department_id, position_id,
      cost_center_id, work_schedule_id, admission_date
    FROM fdp_employees WHERE workspace_id = ? AND id = ?`)
    .bind(input.workspaceId, input.employeeId).first<Record<string, unknown>>();
  if (!employee) return [];
  const rows = await d1.prepare(`SELECT * FROM fdp_employee_history_records
    WHERE workspace_id = ? AND employee_id = ? ORDER BY record_type, valid_from`)
    .bind(input.workspaceId, input.employeeId).all<Record<string, unknown>>();
  const records = rows.results.map(historyRecordFromRow);
  const current = currentValuesFromEmployee(employee);
  const admissionDate = String(employee.admission_date instanceof Date
    ? employee.admission_date.toISOString() : employee.admission_date).slice(0, 10);

  const statements: SqlPreparedStatement[] = [];
  for (const type of historyRecordTypes) {
    const changes = input.changes[type];
    if (!changes) continue;
    const plan = planHistoryChange({ records, type, effectiveDate: input.effectiveDate, changes, current, admissionDate });
    if (plan.kind === "noop") continue;

    if (plan.baseline) {
      statements.push(d1.prepare(`INSERT INTO fdp_employee_history_records (id, workspace_id, employee_id, record_type, valid_from, valid_to, reason, movement_id,
          employment_status, company_id, establishment_id, department_id, position_id, cost_center_id, work_schedule_id, created_by)
        VALUES (?, ?, ?, ?, ?::date, ?::date, 'baseline', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), input.workspaceId, input.employeeId, type, plan.baseline.validFrom, plan.baseline.validTo,
          ...valueBindings(plan.baseline.values), input.userId));
    }
    if (plan.replace) {
      statements.push(d1.prepare(`UPDATE fdp_employee_history_records SET reason = ?, movement_id = ?,
          employment_status = ?, company_id = ?, establishment_id = ?, department_id = ?, position_id = ?,
          cost_center_id = ?, work_schedule_id = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(input.reason, input.movementId ?? null, ...valueBindings(plan.replace.values), input.userId,
          input.workspaceId, plan.replace.id));
    }
    if (plan.delimit) {
      statements.push(d1.prepare(`UPDATE fdp_employee_history_records SET valid_to = ?::date, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND valid_to = ?::date`)
        .bind(plan.delimit.validTo, input.userId, input.workspaceId, plan.delimit.id, plan.delimit.expectedValidTo));
    }
    if (plan.insert) {
      const bindings = [crypto.randomUUID(), input.workspaceId, input.employeeId, type, plan.insert.validFrom, plan.insert.validTo,
        input.reason, input.movementId ?? null, ...valueBindings(plan.insert.values), input.userId];
      /* Com delimitação, o registro novo só nasce se a delimitação de fato
         aconteceu: duas aplicações concorrentes sobre o mesmo registro vigente
         não podem as duas inserir e deixar a linha do tempo sobreposta. A que
         perde não grava histórico, e o aviso de divergência da tela mostra. */
      statements.push(plan.delimit
        ? d1.prepare(`INSERT INTO fdp_employee_history_records (id, workspace_id, employee_id, record_type, valid_from, valid_to, reason, movement_id,
          employment_status, company_id, establishment_id, department_id, position_id, cost_center_id, work_schedule_id, created_by)
            SELECT ?, ?, ?, ?, ?::date, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM fdp_employee_history_records WHERE workspace_id = ? AND id = ? AND valid_to = ?::date)`)
          .bind(...bindings, input.workspaceId, plan.delimit.id, plan.delimit.validTo)
        : d1.prepare(`INSERT INTO fdp_employee_history_records (id, workspace_id, employee_id, record_type, valid_from, valid_to, reason, movement_id,
          employment_status, company_id, establishment_id, department_id, position_id, cost_center_id, work_schedule_id, created_by)
            VALUES (?, ?, ?, ?, ?::date, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(...bindings));
    }
  }
  return statements;
}
