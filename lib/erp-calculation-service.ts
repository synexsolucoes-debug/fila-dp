import { ApiError } from "./api-errors.ts";
import type { WorkspaceRole } from "./fila-dp-types";
import { asBadRequest, contractEndOf, payrollEmployee, remunerationRecords } from "./erp-payroll-service.ts";
import { monthlySalaryOf, parseMoney, remunerationAt } from "./remuneration.ts";
import {
  monthlyPayroll, terminationKinds, terminationPay, thirteenthSalary, vacationDaysByAbsences, vacationPay,
  type TerminationKind,
} from "./payroll-calc.ts";
import { lastDayOfCompetence } from "./erp-dp.ts";
import { autoVariableAverage } from "./payroll-run-service.ts";

/**
 * Cálculo de folha do ERP DP (docs/engenharia-reversa-sap-hcm.md §18): folha
 * do mês, férias, 13º e rescisão de um colaborador, com o salário que estava
 * vigente na data do cálculo — não o de hoje. Usado pela tela (JSON) e pelos
 * documentos (PDF), para os dois nunca divergirem.
 */

export const calculationTypes = ["monthly", "vacation", "thirteenth", "termination"] as const;
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
const number = (value: unknown, fallback = 0) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) throw ApiError.badRequest("Informe números positivos.", "CALCULATION_NUMBER_INVALID");
  return parsed;
};
const money = (value: unknown) => {
  if (value === undefined || value === null || value === "") return 0;
  const cents = parseMoney(value);
  if (cents === null || cents < 0) throw ApiError.badRequest("Valor inválido.", "CALCULATION_AMOUNT_INVALID");
  return cents;
};

export async function calculate(d1: SqlDatabase, workspace: { id: string; role: WorkspaceRole }, userId: string, body: Record<string, unknown>) {
  const type = calculationTypes.find((item) => item === body.type);
  if (!type) throw ApiError.badRequest("Escolha o cálculo.", "CALCULATION_TYPE_INVALID");
  const employee = await payrollEmployee(d1, workspace.id, userId, workspace.role, String(body.employeeId ?? ""));
  const records = await remunerationRecords(d1, workspace.id, employee.id);

  // A data que decide o salário vigente de cada cálculo.
  let referenceDate: string;
  if (type === "monthly") {
    if (typeof body.competence !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(body.competence)) throw ApiError.badRequest("Informe a competência.", "CALCULATION_COMPETENCE_REQUIRED");
    referenceDate = lastDayOfCompetence(body.competence);
  } else if (type === "thirteenth") {
    const year = number(body.year);
    if (!Number.isInteger(year) || year < 2000) throw ApiError.badRequest("Informe o ano.", "CALCULATION_YEAR_REQUIRED");
    referenceDate = `${year}-12-20`;
  } else {
    const date = type === "vacation" ? body.start : body.terminationDate;
    if (!isDate(date)) throw ApiError.badRequest("Informe a data.", "CALCULATION_DATE_REQUIRED");
    referenceDate = date;
  }
  const remuneration = remunerationAt(records, referenceDate) ?? remunerationAt(records, employee.admissionDate);
  if (!remuneration) {
    throw ApiError.badRequest("Cadastre a remuneração do colaborador na aba Remuneração da Ficha funcional antes de calcular.", "REMUNERATION_MISSING");
  }
  const salary = monthlySalaryOf(remuneration);
  // Média de variáveis: a informada vence; sem ela, sai das folhas fechadas
  // dos 12 meses anteriores (férias, 13º e rescisão).
  const informed = body.variableAverage !== undefined && body.variableAverage !== "";
  const average = !informed && type !== "monthly"
    ? { ...(await autoVariableAverage(d1, workspace.id, employee.id, referenceDate)), source: "payroll" as const }
    : { amount: money(body.variableAverage), months: 0, source: "informed" as const };
  const variableAverage = average.amount;

  const entitledDays = body.entitledDays !== undefined && body.entitledDays !== "" ? number(body.entitledDays) : vacationDaysByAbsences(number(body.absences));
  const soldDays = number(body.soldDays);
  const result = asBadRequest(() => {
    switch (type) {
      case "monthly":
        return monthlyPayroll({
          competence: String(body.competence), salary, monthlyHours: remuneration.monthlyHours, dependents: remuneration.irrfDependents,
          overtime50Hours: number(body.overtime50Hours), overtime100Hours: number(body.overtime100Hours),
          workingDays: number(body.workingDays), restDays: number(body.restDays), absenceDays: number(body.absenceDays),
          unhealthyPercent: remuneration.unhealthyPercent, hazardous: remuneration.hazardous,
          otherEarnings: money(body.otherEarnings), otherDeductions: money(body.otherDeductions), alimony: money(body.alimony),
        });
      case "vacation":
        return vacationPay({ start: referenceDate, salary, variableAverage, entitledDays, soldDays, dependents: remuneration.irrfDependents });
      case "thirteenth":
        return thirteenthSalary({
          year: Number(body.year), admissionDate: employee.admissionDate, salary, variableAverage,
          dependents: remuneration.irrfDependents, firstInstallmentPaid: money(body.firstInstallmentPaid),
        });
      default:
        return null;
    }
  });
  if (type !== "termination" && result) {
    return { type, employee, remuneration, salary, referenceDate, average, result, vacation: type === "vacation" ? { entitledDays, soldDays } : null };
  }

  const kind = terminationKinds.find((item) => item === body.kind) as TerminationKind | undefined;
  if (!kind) throw ApiError.badRequest("Escolha o tipo de desligamento.", "TERMINATION_KIND_INVALID");
  const contractEnd = isDate(body.contractEnd) ? body.contractEnd : await contractEndOf(d1, workspace.id, employee.id);
  const termination = asBadRequest(() => terminationPay({
    kind, admissionDate: employee.admissionDate, terminationDate: referenceDate, salary, variableAverage,
    dependents: remuneration.irrfDependents, noticeWorked: body.noticeWorked === true,
    discountUnworkedNotice: body.discountUnworkedNotice === true,
    overdueVacationPeriods: number(body.overdueVacationPeriods),
    fgtsBalance: body.fgtsBalance === undefined || body.fgtsBalance === "" ? undefined : money(body.fgtsBalance),
    contractEnd: contractEnd ?? undefined, thirteenthAdvance: money(body.thirteenthAdvance),
  }));
  return { type, kind, employee, remuneration, salary, referenceDate, average, result: termination };
}
