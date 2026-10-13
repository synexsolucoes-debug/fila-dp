import { monthlyPayroll, type PayrollLine, type PayrollResult } from "./payroll-calc.ts";
import { monthlySalaryOf, type Remuneration } from "./remuneration.ts";

/**
 * Folha da competência do ERP DP — a montagem de cada colaborador
 * (docs/engenharia-reversa-sap-hcm.md §18, item 10 do roadmap).
 *
 * É o "esquema" do PC00 do SAP sem a configuração: as entradas vêm do que o
 * Vinculato já registra — a folha de ponto aprovada (horas extras, adicional
 * noturno, faltas e atrasos), as parcelas de Adiantamentos e Descontos da
 * competência, o vale-transporte e o vale-refeição da remuneração, e a
 * diferença dos retroativos — e cada uma fica registrada em `inputs` para
 * quem confere saber de onde veio.
 *
 * Puro: quem lê o banco e grava é `lib/payroll-run-service.ts`.
 */

export type RunEmployee = {
  id: string;
  fullName: string;
  registrationNumber: string;
  admissionDate: string;
  terminationDate: string | null;
  employmentStatus: string;
};

/** Minutos por evento da folha de ponto (os códigos de `fdp_time_sheet_events`). */
export type TimeInput = {
  sheetId: string;
  status: string;
  events: Partial<Record<string, number>>;
};

export type InstallmentInput = { id: string; entryId: string; label: string; amountCents: number };

/** Diferença de um retroativo: o salário de hoje para aquela competência contra o que a folha fechada pagou. */
export type RetroInput = { itemId: string; competence: string; amountCents: number };

/** Só ponto aprovado entra na folha: rascunho e revisão ainda podem mudar. */
export const approvedTimeStatuses = ["approved", "exported", "closed"] as const;


/** Dias úteis (segunda a sábado) e domingos do mês — a base do DSR. Feriados não entram: o cálculo avisa. */
export function monthCalendar(competence: string) {
  const [y, m] = competence.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let sundays = 0;
  for (let day = 1; day <= days; day += 1) if (new Date(Date.UTC(y, m - 1, day)).getUTCDay() === 0) sundays += 1;
  return { days, workingDays: days - sundays, restDays: sundays };
}

/**
 * Quem entra na folha do mês e quem fica de fora, com o motivo. Desligado no
 * mês é rescisão (Cálculos › Rescisão); afastado não recebe salário da
 * empresa (o INSS paga a partir do 16º dia); sem remuneração, não há conta.
 */
export function eligibility(employee: RunEmployee, competence: string, remuneration: Remuneration | null): string | null {
  const start = `${competence}-01`;
  const [y, m] = competence.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  if (employee.admissionDate > end) return "Admitido depois da competência";
  if (employee.terminationDate && employee.terminationDate < start) return "Desligado antes da competência";
  if (employee.terminationDate && employee.terminationDate <= end) return "Desligado na competência: calcule a rescisão em Cálculos › Rescisão";
  if (employee.employmentStatus === "on_leave") return "Afastado: o salário do mês não é pago pela empresa";
  if (!remuneration) return "Sem remuneração vigente: cadastre na Ficha funcional › Remuneração";
  return null;
}

export type EmployeePayroll = {
  result: PayrollResult;
  salary: number;
  inputs: {
    remunerationId: string;
    workedDays: number;
    time: { sheetId: string; status: string; used: boolean } | null;
    installments: string[];
    retroactive: string[];
  };
};

export function employeePayroll(input: {
  competence: string;
  employee: RunEmployee;
  remuneration: Remuneration;
  time: TimeInput | null;
  installments: readonly InstallmentInput[];
  retroactive: readonly RetroInput[];
}): EmployeePayroll {
  const { competence, employee, remuneration } = input;
  const salary = monthlySalaryOf(remuneration);
  const calendar = monthCalendar(competence);
  // Admitido no meio do mês: proporcional no mês comercial de 30 dias.
  const admittedThisMonth = employee.admissionDate.slice(0, 7) === competence;
  const workedDays = admittedThisMonth ? Math.max(1, 30 - (Number(employee.admissionDate.slice(8, 10)) - 1)) : 30;

  const useTime = Boolean(input.time && (approvedTimeStatuses as readonly string[]).includes(input.time.status));
  const minutes = (code: string) => (useTime ? input.time?.events[code] ?? 0 : 0);
  const extraLines: PayrollLine[] = [];
  const all = { inss: true, irrf: true, fgts: true };
  for (const retro of input.retroactive) {
    if (retro.amountCents <= 0) continue;
    extraLines.push({ code: "1095", label: `Diferença salarial retroativa ${retro.competence}`, kind: "earning", amount: retro.amountCents, reference: retro.competence, incidence: all });
  }
  for (const installment of input.installments) {
    if (installment.amountCents <= 0) continue;
    extraLines.push({ code: "5060", label: installment.label, kind: "deduction", amount: installment.amountCents, reference: "Adiantamentos e Descontos" });
  }

  const result = monthlyPayroll({
    competence, salary, monthlyHours: remuneration.monthlyHours, dependents: remuneration.irrfDependents,
    workedDays,
    overtime50Hours: minutes("overtime_50") / 60,
    overtime100Hours: minutes("overtime_100") / 60,
    nightMinutes: minutes("night_hours"),
    absenceHours: (minutes("absence_hours") + minutes("late_hours")) / 60,
    workingDays: calendar.workingDays, restDays: calendar.restDays,
    unhealthyPercent: remuneration.unhealthyPercent, hazardous: remuneration.hazardous,
    transportVoucherCost: remuneration.transportVoucherCents,
    mealVoucherDiscount: remuneration.mealVoucherDiscountCents,
    extraLines,
  });
  if (input.time && !useTime) result.notes.push("A folha de ponto ainda não foi aprovada: horas extras, adicional noturno e faltas não entraram.");
  if (!input.time) result.notes.push("Sem folha de ponto na competência: nenhuma hora variável entrou.");
  if (minutes("overtime_50") + minutes("overtime_100") > 0) result.notes.push("DSR calculado com os domingos do mês; feriados não estão no calendário da empresa.");
  if (admittedThisMonth) result.notes.push(`Admissão no mês: salário de ${workedDays} dias.`);
  return {
    result, salary,
    inputs: {
      remunerationId: remuneration.id,
      workedDays,
      time: input.time ? { sheetId: input.time.sheetId, status: input.time.status, used: useTime } : null,
      installments: input.installments.filter((item) => item.amountCents > 0).map((item) => item.id),
      retroactive: input.retroactive.filter((item) => item.amountCents > 0).map((item) => item.itemId),
    },
  };
}

/** Totais da folha: proventos, descontos, líquido e FGTS. */
export function runTotals(results: readonly { result: PayrollResult }[]) {
  return results.reduce((acc, { result }) => ({
    earnings: acc.earnings + result.earnings,
    deductions: acc.deductions + result.deductions,
    net: acc.net + result.net,
    fgts: acc.fgts + result.fgts,
  }), { earnings: 0, deductions: 0, net: 0, fgts: 0 });
}
