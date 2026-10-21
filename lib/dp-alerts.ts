/**
 * DP Operacional, Fase 4 — alertas a partir dos dados do Sankhya.
 *
 * Experiência que vence sem ninguém decidir vira contrato por prazo
 * indeterminado sem querer; férias que estouram o período concessivo saem em
 * dobro (CLT art. 137); cadastro incompleto trava a folha no fechamento. Os
 * três já estão nos dados que a sincronização do Sankhya traz — faltava olhar
 * para eles todo dia. `computeAlerts` diz quais alertas o dia tem; o job
 * diário grava, atualiza e encerra (`lib/dp-alerts-service.ts`).
 *
 * Puro: sem banco, sem relógio — `today` chega por parâmetro.
 *
 * ## Experiência
 *
 * Contrato de experiência de 45 + 45 dias (o padrão do grupo): o primeiro
 * período termina no 45º dia contando a admissão (admissão + 44) e a
 * prorrogação no 90º (admissão + 89). O alerta abre 10 dias antes e continua
 * aberto até 15 dias depois do vencimento, como atrasado, se ninguém decidir.
 *
 * ## Férias
 *
 * O Vinculato não tem a tabela de períodos aquisitivos do Sankhya. O cálculo
 * usa a admissão e as férias registradas como movimentação: com N férias
 * registradas, o período pendente é o N+1; o aquisitivo dele termina em
 * admissão + (N+1) anos − 1 dia e o concessivo, 12 meses depois. Alerta com 60
 * dias; urgente com 30; atrasado depois do limite. Férias fracionadas contam
 * uma vez por movimentação — é uma aproximação, dita na tela, até a tabela de
 * férias do Sankhya entrar na sincronização.
 */
import { addDays, calendarDaysBetween, dayLabel } from "./dp-calendar.ts";

export const alertTypes = ["experience_45", "experience_90", "vacation_deadline", "registration_incomplete"] as const;
export type AlertType = typeof alertTypes[number];
export type AlertSeverity = "warning" | "urgent" | "overdue";

export const alertTypeLabels: Record<AlertType, string> = {
  experience_45: "Experiência — 1º período (45 dias)",
  experience_90: "Experiência — prorrogação (90 dias)",
  vacation_deadline: "Férias — limite do período concessivo",
  registration_incomplete: "Cadastro incompleto",
};

export const severityLabels: Record<AlertSeverity, string> = { warning: "No radar", urgent: "Urgente", overdue: "Vencido" };

export type AlertEmployee = {
  id: string;
  name: string;
  companyId: string;
  admissionDate: string;
  employmentStatus: string;
  employmentType: string;
  cpfLast4: string;
  sankhyaCode: string;
  vacationsTaken: number;
  managerEmail: string;
};

export type AlertCompany = {
  id: string;
  name: string;
  taxId: string;
  code: string;
  dpStatus: string;
  status: string;
};

export type ExpectedAlert = {
  key: string;
  type: AlertType;
  companyId: string | null;
  employeeId: string | null;
  dueDate: string | null;
  severity: AlertSeverity;
  title: string;
  detail: string;
  managerEmail: string;
};

export const EXPERIENCE_NOTICE_DAYS = 10;
export const EXPERIENCE_GRACE_DAYS = 15;
export const VACATION_NOTICE_DAYS = 60;
export const VACATION_URGENT_DAYS = 30;

/** Último dia do 1º período (45 dias) e da prorrogação (90 dias), contando a admissão. */
export function experienceMilestones(admissionDate: string) {
  return { first: addDays(admissionDate, 44), second: addDays(admissionDate, 89) };
}

/** Somar anos sem escorregar em 29/02: cai em 28/02 no ano não bissexto. */
export function addYears(date: string, years: number) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year + years, month - 1, day, 12));
  if (target.getUTCMonth() !== month - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

/** Período pendente de férias e o limite do concessivo. */
export function vacationDeadline(admissionDate: string, vacationsTaken: number) {
  const period = Math.max(0, vacationsTaken) + 1;
  const acquisitiveEnd = addDays(addYears(admissionDate, period), -1);
  const concessiveEnd = addDays(addYears(admissionDate, period + 1), -1);
  return { period, acquisitiveEnd, concessiveEnd };
}

function severityFor(today: string, due: string, urgentDays: number): AlertSeverity {
  const days = calendarDaysBetween(today, due);
  if (days < 0) return "overdue";
  return days <= urgentDays ? "urgent" : "warning";
}

export function computeAlerts(input: {
  employees: readonly AlertEmployee[];
  companies: readonly AlertCompany[];
  today: string;
}): ExpectedAlert[] {
  const { today } = input;
  const companyById = new Map(input.companies.map((company) => [company.id, company]));
  const alerts: ExpectedAlert[] = [];

  for (const employee of input.employees) {
    if (employee.employmentStatus === "terminated") continue;
    const company = companyById.get(employee.companyId);
    const where = company ? ` — ${company.name}` : "";

    if (employee.employmentType === "clt" && employee.employmentStatus === "active") {
      const { first, second } = experienceMilestones(employee.admissionDate);
      for (const [type, end, label] of [["experience_45", first, "45 dias"], ["experience_90", second, "90 dias"]] as const) {
        const daysLeft = calendarDaysBetween(today, end);
        if (daysLeft > EXPERIENCE_NOTICE_DAYS || daysLeft < -EXPERIENCE_GRACE_DAYS) continue;
        alerts.push({
          key: `${type}:${employee.id}`, type, companyId: employee.companyId, employeeId: employee.id, dueDate: end,
          severity: severityFor(today, end, 3),
          title: `Experiência (${label}) de ${employee.name} vence em ${dayLabel(end)}${where}`,
          detail: `Admissão em ${dayLabel(employee.admissionDate)}. Pergunta ao gestor: efetivar, prorrogar ou desligar?`,
          managerEmail: employee.managerEmail,
        });
      }
    }

    if (employee.employmentType !== "intern") {
      const { period, acquisitiveEnd, concessiveEnd } = vacationDeadline(employee.admissionDate, employee.vacationsTaken);
      const daysLeft = calendarDaysBetween(today, concessiveEnd);
      if (today > acquisitiveEnd && daysLeft <= VACATION_NOTICE_DAYS) {
        alerts.push({
          key: `vacation_deadline:${employee.id}:${period}`, type: "vacation_deadline", companyId: employee.companyId, employeeId: employee.id,
          dueDate: concessiveEnd, severity: severityFor(today, concessiveEnd, VACATION_URGENT_DAYS),
          title: `Férias de ${employee.name}: limite do concessivo em ${dayLabel(concessiveEnd)}${where}`,
          detail: `${period}º período aquisitivo terminou em ${dayLabel(acquisitiveEnd)}. Depois do limite, as férias são pagas em dobro (CLT art. 137).`,
          managerEmail: employee.managerEmail,
        });
      }
    }

    const missing: string[] = [];
    if (!employee.cpfLast4) missing.push("CPF");
    if (!employee.sankhyaCode) missing.push("código do Sankhya (CODFUNC)");
    if (company && company.dpStatus === "sem_funcionarios") missing.push(`ativo na ${company.name}, marcada como sem funcionários (mesmo CPF em outra empresa da raiz?)`);
    if (missing.length) {
      alerts.push({
        key: `registration_incomplete:employee:${employee.id}`, type: "registration_incomplete", companyId: employee.companyId, employeeId: employee.id,
        dueDate: null, severity: "warning", title: `Cadastro incompleto: ${employee.name}${where}`,
        detail: `Falta ou diverge: ${missing.join("; ")}.`, managerEmail: "",
      });
    }
  }

  for (const company of input.companies) {
    if (company.status !== "active" || company.dpStatus !== "interno") continue;
    const missing: string[] = [];
    if (!company.taxId.replace(/\D/gu, "")) missing.push("CNPJ");
    else if (company.taxId.replace(/\D/gu, "").length !== 14) missing.push("CNPJ com 14 dígitos");
    if (!company.code) missing.push("código do Sankhya (CODEMP)");
    if (missing.length) {
      alerts.push({
        key: `registration_incomplete:company:${company.id}`, type: "registration_incomplete", companyId: company.id, employeeId: null,
        dueDate: null, severity: "warning", title: `Cadastro incompleto: empresa ${company.name}`,
        detail: `Falta: ${missing.join(", ")}.`, managerEmail: "",
      });
    }
  }
  return alerts;
}

export type AlertSummaryRow = { key: string; label: string; total: number; overdue: number; urgent: number };

/** Contagem por tipo e por responsável para o painel da Central. */
export function summarizeAlerts(alerts: Array<{ type: string; severity: string; assignedName: string | null }>) {
  const count = (keyOf: (alert: { type: string; severity: string; assignedName: string | null }) => [string, string]) => {
    const rows = new Map<string, AlertSummaryRow>();
    for (const alert of alerts) {
      const [key, label] = keyOf(alert);
      const row = rows.get(key) ?? { key, label, total: 0, overdue: 0, urgent: 0 };
      row.total += 1;
      if (alert.severity === "overdue") row.overdue += 1;
      if (alert.severity === "urgent") row.urgent += 1;
      rows.set(key, row);
    }
    return [...rows.values()].sort((left, right) => right.total - left.total || left.label.localeCompare(right.label));
  };
  return {
    byType: count((alert) => [alert.type, alertTypeLabels[alert.type as AlertType] ?? alert.type]),
    byHolder: count((alert) => [alert.assignedName ?? "", alert.assignedName || "Sem responsável"]),
  };
}
