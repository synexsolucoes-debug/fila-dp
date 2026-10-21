import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { payrollEmployee } from "@/lib/erp-payroll-service";
import { todayInBrazil } from "@/lib/employee-history";
import { vacationPeriods } from "@/lib/vacation-balance";
import { prepareSchedule, schedulesOf } from "@/lib/vacation-service";

type RouteContext = { params: Promise<{ id: string }> };

/** Períodos aquisitivos, saldo e programações de férias do colaborador (ERP DP, §4.39). */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.read");
    const employee = await payrollEmployee(d1, workspace.id, user.id, workspace.role, id);
    const schedules = await schedulesOf(d1, workspace.id, [id]);
    const today = todayInBrazil();
    return Response.json({ admissionDate: employee.admissionDate, today, periods: vacationPeriods(employee.admissionDate, today, schedules, employee.terminationDate), schedules });
  } catch (error) { return apiError(error); }
}

/** Programa férias, com as regras dos arts. 134, 135 e 143 da CLT. */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.manage");
    const employee = await payrollEmployee(d1, workspace.id, user.id, workspace.role, id);
    const existing = await schedulesOf(d1, workspace.id, [id]);
    const today = todayInBrazil();
    const planned = prepareSchedule(d1, {
      workspaceId: workspace.id, companyId: employee.companyId, employeeId: id, admissionDate: employee.admissionDate, today,
      userId: user.id, existing, body,
    });
    await d1.batch([planned.statement, prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "employee.vacation.planned", entityType: "employee", entityId: id,
      before: null, after: { scheduleId: planned.id, acquisitiveStart: planned.acquisitiveStart, startDate: body.startDate, restDays: body.restDays, soldDays: body.soldDays ?? 0 },
      metadata: { scope: "company", companyId: employee.companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
    })]);
    const schedules = await schedulesOf(d1, workspace.id, [id]);
    return Response.json({
      schedule: { id: planned.id, end: planned.end, returnDate: planned.returnDate, paymentDue: planned.paymentDue, noticeDeadline: planned.noticeDeadline },
      warnings: planned.warnings, periods: vacationPeriods(employee.admissionDate, today, schedules, employee.terminationDate), schedules,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
