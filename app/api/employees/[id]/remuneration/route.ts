import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { asBadRequest, payrollEmployee, remunerationRecords } from "@/lib/erp-payroll-service";
import { monthlySalaryOf, parseRemunerationInput, planRemuneration, remunerationAt, remunerationGaps } from "@/lib/remuneration";
import { todayInBrazil } from "@/lib/employee-history";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Remuneração do colaborador (ERP DP — infotipo 0008 do SAP), com vigência.
 * Salário é permissão própria: `payroll.read` para ver, `payroll.manage` para
 * gravar. Quem só lê o cadastro não vê quanto a pessoa ganha.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    const employee = await payrollEmployee(d1, workspace.id, user.id, workspace.role, id);
    const records = await remunerationRecords(d1, workspace.id, id);
    const current = remunerationAt(records, todayInBrazil());
    return Response.json({
      admissionDate: employee.admissionDate,
      records,
      current,
      currentMonthlySalary: current ? monthlySalaryOf(current) : null,
      gaps: remunerationGaps(records),
    });
  } catch (error) { return apiError(error); }
}

/**
 * Grava um registro de remuneração. Início novo delimita o registro que
 * cobria a data; o mesmo início corrige o registro. Tudo no mesmo lote, com
 * a auditoria.
 */
export async function PUT(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.manage");
    const employee = await payrollEmployee(d1, workspace.id, user.id, workspace.role, id);
    const input = asBadRequest(() => parseRemunerationInput(body, employee.admissionDate));
    const records = await remunerationRecords(d1, workspace.id, id);
    const plan = planRemuneration(records, input.validFrom);
    const before = plan.mode === "correct" ? records.find((record) => record.id === plan.id) ?? null
      : plan.delimit ? records.find((record) => record.id === plan.delimit?.id) ?? null : null;
    const statements: D1PreparedStatement[] = [];
    if (plan.mode === "correct") {
      statements.push(d1.prepare(`UPDATE fdp_employee_remuneration SET salary_kind = ?, amount_cents = ?, monthly_hours = ?,
          irrf_dependents = ?, unhealthy_percent = ?, hazardous = ?, transport_voucher_cents = ?, meal_voucher_discount_cents = ?,
          pro_labore = ?, family_allowance_children = ?, alimony_percent = ?, alimony_base = ?, reason = ?, notes = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(input.salaryKind, input.amountCents, input.monthlyHours, input.irrfDependents, input.unhealthyPercent,
          input.hazardous, input.transportVoucherCents, input.mealVoucherDiscountCents,
          input.proLabore, input.familyAllowanceChildren, input.alimonyPercent, input.alimonyBase, input.reason, input.notes, user.id, workspace.id, plan.id));
    } else {
      if (plan.delimit) {
        statements.push(d1.prepare("UPDATE fdp_employee_remuneration SET valid_to = ?::date, updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?")
          .bind(plan.delimit.validTo, user.id, workspace.id, plan.delimit.id));
      }
      statements.push(d1.prepare(`INSERT INTO fdp_employee_remuneration
          (id, workspace_id, employee_id, valid_from, valid_to, salary_kind, amount_cents, monthly_hours, irrf_dependents,
           unhealthy_percent, hazardous, transport_voucher_cents, meal_voucher_discount_cents,
           pro_labore, family_allowance_children, alimony_percent, alimony_base, reason, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?::date, ?::date, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, input.validFrom, plan.validTo, input.salaryKind, input.amountCents,
          input.monthlyHours, input.irrfDependents, input.unhealthyPercent, input.hazardous, input.transportVoucherCents,
          input.mealVoucherDiscountCents, input.proLabore, input.familyAllowanceChildren, input.alimonyPercent, input.alimonyBase,
          input.reason, input.notes, user.id, user.id));
    }
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: plan.mode === "correct" ? "employee.remuneration.corrected" : "employee.remuneration.created",
      entityType: "employee", entityId: id,
      before, after: input,
      metadata: { scope: "company", companyId: employee.companyId },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));
    await d1.batch(statements);
    const after = await remunerationRecords(d1, workspace.id, id);
    return Response.json({ records: after, mode: plan.mode, gaps: remunerationGaps(after) });
  } catch (error) { return apiError(error); }
}
