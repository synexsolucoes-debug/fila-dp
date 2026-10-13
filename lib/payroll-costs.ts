import type { PayrollLine } from "./payroll-calc.ts";
import type { CompanyPayrollSettings } from "./payroll-obligations.ts";

/**
 * Custo de pessoal do ERP DP (§4.37 da arquitetura): quanto cada pessoa custa
 * à empresa no mês, além do salário — encargos, FGTS, provisões de férias e
 * 13º com os encargos delas e o vale-transporte que a empresa banca — e o
 * agrupamento por centro de custo e departamento.
 *
 * Puro: quem lê as folhas e o cadastro é a rota.
 */

export type CostInput = {
  employeeId: string;
  name: string;
  registrationNumber: string;
  departmentName: string;
  costCenterName: string;
  salaryCents: number;
  earningsCents: number;
  fgtsCents: number;
  transportVoucherCents: number;
  lines: readonly PayrollLine[];
};

export type EmployeeCost = {
  employeeId: string;
  name: string;
  registrationNumber: string;
  departmentName: string;
  costCenterName: string;
  /** Proventos que são despesa (sem o salário-família, que é compensado no INSS). */
  earnings: number;
  employerContribution: number;
  fgts: number;
  vacationProvision: number;
  thirteenthProvision: number;
  provisionCharges: number;
  transportVoucher: number;
  total: number;
};

const value = (lines: readonly PayrollLine[], code: string) => lines.find((line) => line.code === code)?.amount ?? 0;
const round = (amount: number) => Math.round(amount);

export function employeeCost(input: CostInput, settings: CompanyPayrollSettings): EmployeeCost {
  const standard = settings.employerContribution === "standard";
  const employeeRate = standard ? 0.2 + (settings.ratPercent / 100) * settings.fap + settings.thirdPartiesPercent / 100 : 0;
  const employeeBase = value(input.lines, "9000");
  const partnerBase = value(input.lines, "9002");
  const employerContribution = round(employeeBase * employeeRate + partnerBase * (standard ? 0.2 : 0));
  // Provisões só para quem tem férias e 13º da CLT: sem base de empregado, não há.
  const hasClt = employeeBase > 0;
  const fgtsRate = input.earningsCents > 0 && input.fgtsCents > 0 ? input.fgtsCents / Math.max(1, employeeBase || input.earningsCents) : 0;
  const vacationProvision = hasClt ? round((input.salaryCents / 12) * (4 / 3)) : 0;
  const thirteenthProvision = hasClt ? round(input.salaryCents / 12) : 0;
  const provisionCharges = round((vacationProvision + thirteenthProvision) * (employeeRate + fgtsRate));
  // O vale-transporte que a empresa banca é o custo menos o desconto do empregado.
  const transportVoucher = Math.max(0, input.transportVoucherCents - value(input.lines, "5050"));
  const earnings = input.earningsCents - value(input.lines, "1060");
  const total = earnings + employerContribution + input.fgtsCents + vacationProvision + thirteenthProvision + provisionCharges + transportVoucher;
  return {
    employeeId: input.employeeId, name: input.name, registrationNumber: input.registrationNumber,
    departmentName: input.departmentName, costCenterName: input.costCenterName,
    earnings, employerContribution, fgts: input.fgtsCents, vacationProvision, thirteenthProvision, provisionCharges, transportVoucher, total,
  };
}

export type CostGroup = { key: string; people: number; earnings: number; charges: number; provisions: number; total: number };

/** Soma por centro de custo ou departamento; "Sem centro de custo" fica visível, não some. */
export function groupCosts(costs: readonly EmployeeCost[], by: "costCenterName" | "departmentName"): CostGroup[] {
  const groups = new Map<string, CostGroup>();
  for (const cost of costs) {
    const key = cost[by] || (by === "costCenterName" ? "Sem centro de custo" : "Sem departamento");
    const group = groups.get(key) ?? { key, people: 0, earnings: 0, charges: 0, provisions: 0, total: 0 };
    group.people += 1;
    group.earnings += cost.earnings;
    group.charges += cost.employerContribution + cost.fgts + cost.provisionCharges;
    group.provisions += cost.vacationProvision + cost.thirteenthProvision;
    group.total += cost.total;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

export function costTotals(costs: readonly EmployeeCost[]) {
  return costs.reduce((acc, cost) => ({
    earnings: acc.earnings + cost.earnings,
    charges: acc.charges + cost.employerContribution + cost.fgts + cost.provisionCharges,
    provisions: acc.provisions + cost.vacationProvision + cost.thirteenthProvision,
    benefits: acc.benefits + cost.transportVoucher,
    total: acc.total + cost.total,
  }), { earnings: 0, charges: 0, provisions: 0, benefits: 0, total: 0 });
}
