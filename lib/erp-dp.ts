import { recordAt, previousDay, type EmploymentStatus, type HistoryRecord } from "./employee-history.ts";

/**
 * ERP DP — as leituras que a engenharia reversa do SAP HCM trouxe para o
 * Vinculato (docs/engenharia-reversa-sap-hcm.md §11.3, §8.2 e §7.4).
 *
 * Tudo aqui é leitura derivada do Histórico funcional (§4.27): o quadro de
 * pessoal numa data-base, os eventos do eSocial que as mudanças do mês exigem
 * e o sinal de retroatividade. O cálculo de folha mora em
 * lib/payroll-calc.ts; aqui só há leitura do histórico.
 *
 * Este arquivo é puro: não acessa banco nem sessão.
 */

/* -------------------------------------------------------------------------- */
/* Quadro de pessoal em data-base (o "dia-chave" da base lógica PNP do SAP)   */
/* -------------------------------------------------------------------------- */

export type HeadcountEmployee = {
  id: string;
  fullName: string;
  registrationNumber: string;
  admissionDate: string;
  terminationDate: string | null;
  employmentStatus: EmploymentStatus;
  companyId: string;
  establishmentId: string | null;
  departmentId: string | null;
  positionId: string | null;
  costCenterId: string | null;
  workScheduleId: string | null;
};

export type HeadcountRow = {
  employeeId: string;
  fullName: string;
  registrationNumber: string;
  status: EmploymentStatus;
  companyId: string;
  establishmentId: string | null;
  departmentId: string | null;
  positionId: string | null;
  costCenterId: string | null;
  workScheduleId: string | null;
  /**
   * De onde veio a fotografia. `history` é o registro vigente na data;
   * `current` é o cadastro de hoje, usado quando a pessoa ainda não tem
   * histórico daquele tipo — a tela precisa dizer que é aproximação.
   */
  source: "history" | "current";
};

/**
 * A situação de uma pessoa sem histórico de situação, inferida das datas do
 * cadastro. Desligamento no passado em relação à data-base vale; o resto
 * fica com o status atual, que é o melhor dado que existe.
 */
function inferredStatus(employee: HeadcountEmployee, at: string): EmploymentStatus {
  if (employee.terminationDate && employee.terminationDate < at) return "terminated";
  // Desligado com data de desligamento a partir da data-base: naquele dia o
  // vínculo ainda existia. Sem data, não há como saber — fica desligado.
  if (employee.employmentStatus === "terminated") return employee.terminationDate ? "active" : "terminated";
  return employee.employmentStatus;
}

export type EmployeeHistoryRecord = HistoryRecord & { employeeId: string };

export function headcountAt(employees: readonly HeadcountEmployee[], records: readonly EmployeeHistoryRecord[], at: string): HeadcountRow[] {
  const byEmployee = new Map<string, HistoryRecord[]>();
  for (const record of records) {
    const list = byEmployee.get(record.employeeId) ?? [];
    list.push(record);
    byEmployee.set(record.employeeId, list);
  }
  const rows: HeadcountRow[] = [];
  for (const employee of employees) {
    // Quem ainda não tinha sido admitido na data-base não está no quadro.
    if (employee.admissionDate > at) continue;
    const own = byEmployee.get(employee.id) ?? [];
    const situation = recordAt(own, "situation", at);
    const assignment = recordAt(own, "assignment", at);
    const schedule = recordAt(own, "schedule", at);
    rows.push({
      employeeId: employee.id,
      fullName: employee.fullName,
      registrationNumber: employee.registrationNumber,
      status: situation?.employmentStatus ?? inferredStatus(employee, at),
      companyId: assignment?.companyId ?? employee.companyId,
      establishmentId: assignment ? assignment.establishmentId : employee.establishmentId,
      departmentId: assignment ? assignment.departmentId : employee.departmentId,
      positionId: assignment ? assignment.positionId : employee.positionId,
      costCenterId: assignment ? assignment.costCenterId : employee.costCenterId,
      workScheduleId: schedule ? schedule.workScheduleId : employee.workScheduleId,
      source: situation && assignment ? "history" : "current",
    });
  }
  return rows.sort((a, b) => a.fullName.localeCompare(b.fullName, "pt-BR"));
}

export type HeadcountSummary = {
  total: number;
  byStatus: Record<EmploymentStatus, number>;
  byDepartment: Array<{ departmentId: string | null; active: number; onLeave: number }>;
  approximated: number;
};

/** "Total" é quem tem vínculo na data — ativo ou afastado. Desligado não conta no quadro. */
export function summarizeHeadcount(rows: readonly HeadcountRow[]): HeadcountSummary {
  const byStatus: Record<EmploymentStatus, number> = { active: 0, on_leave: 0, terminated: 0 };
  const departments = new Map<string | null, { active: number; onLeave: number }>();
  let approximated = 0;
  for (const row of rows) {
    byStatus[row.status] += 1;
    if (row.source === "current") approximated += 1;
    if (row.status === "terminated") continue;
    const entry = departments.get(row.departmentId) ?? { active: 0, onLeave: 0 };
    if (row.status === "active") entry.active += 1; else entry.onLeave += 1;
    departments.set(row.departmentId, entry);
  }
  return {
    total: byStatus.active + byStatus.on_leave,
    byStatus,
    byDepartment: [...departments.entries()]
      .map(([departmentId, counts]) => ({ departmentId, ...counts }))
      .sort((a, b) => (b.active + b.onLeave) - (a.active + a.onLeave)),
    approximated,
  };
}

/* -------------------------------------------------------------------------- */
/* eSocial esperado (mapa da §8.2)                                            */
/* -------------------------------------------------------------------------- */

export type ExpectedEsocialEvent = {
  event: "S-2206" | "S-2230" | "S-2299";
  label: string;
  employeeId: string;
  recordId: string;
  /** A data que o evento informa: início do afastamento, data de desligamento, vigência da alteração. */
  date: string;
  detail: string;
};

/**
 * Os eventos não periódicos que as mudanças registradas no mês exigem do
 * sistema de folha. É uma lista de conferência: o Vinculato não transmite,
 * mas sabe o que deveria ter sido transmitido.
 *
 * - lotação ou jornada nova → S-2206 (alteração contratual);
 * - situação afastado → S-2230 (início); afastado → ativo → S-2230 (término,
 *   com o último dia de afastamento);
 * - situação desligado → S-2299, com a véspera como data de desligamento
 *   (o registro "desligado" começa no dia seguinte ao último dia).
 *
 * Todo evento pertence ao mês da data que ele informa — é por essa data que
 * a conferência (`POST /api/erp-dp/esocial/checks`) o encontra de novo.
 * A linha de base não gera evento: ela é o que já existia, não uma mudança.
 */
export function expectedEsocialEvents(records: readonly EmployeeHistoryRecord[], competence: string): ExpectedEsocialEvent[] {
  const start = `${competence}-01`;
  const end = lastDayOfCompetence(competence);
  const byEmployee = new Map<string, EmployeeHistoryRecord[]>();
  for (const record of records) {
    const list = byEmployee.get(record.employeeId) ?? [];
    list.push(record);
    byEmployee.set(record.employeeId, list);
  }
  const events: ExpectedEsocialEvent[] = [];
  for (const [employeeId, list] of byEmployee) {
    for (const record of list) {
      if (record.reason === "baseline") continue;
      if (record.recordType === "situation") {
        const before = recordAt(list, "situation", previousDay(record.validFrom));
        if (record.employmentStatus === "on_leave") {
          if (inMonth(record.validFrom, start, end)) {
            events.push({ event: "S-2230", label: "Afastamento temporário — início", employeeId, recordId: record.id, date: record.validFrom, detail: "Afastamento a partir desta data" });
          }
        } else if (record.employmentStatus === "active" && before?.employmentStatus === "on_leave") {
          // O evento informa o último dia de afastamento, e é o mês dessa data
          // que ele pertence — a mesma regra do desligamento logo abaixo.
          const lastDay = previousDay(record.validFrom);
          if (inMonth(lastDay, start, end)) {
            events.push({ event: "S-2230", label: "Afastamento temporário — término", employeeId, recordId: record.id, date: lastDay, detail: "Último dia de afastamento" });
          }
        } else if (record.employmentStatus === "terminated") {
          const lastDay = previousDay(record.validFrom);
          if (inMonth(lastDay, start, end)) {
            events.push({ event: "S-2299", label: "Desligamento", employeeId, recordId: record.id, date: lastDay, detail: "Data de desligamento (último dia do vínculo)" });
          }
        }
        continue;
      }
      if (inMonth(record.validFrom, start, end)) {
        events.push({
          event: "S-2206", label: "Alteração contratual", employeeId, recordId: record.id, date: record.validFrom,
          detail: record.recordType === "schedule" ? "Mudança de jornada" : "Mudança de lotação (empresa, unidade, departamento, cargo ou centro de custo)",
        });
      }
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.event.localeCompare(b.event));
}

function inMonth(date: string, start: string, end: string) {
  return start <= date && date <= end;
}

export function lastDayOfCompetence(competence: string) {
  const [year, month] = competence.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Retroatividade (o infotipo 0003 do SAP, sem recálculo)                     */
/* -------------------------------------------------------------------------- */

/**
 * Competência já processada — a folha daquele mês já foi calculada ou está
 * sendo, e uma mudança com data dentro dele precisa virar diferença na
 * próxima. `open` e `pre_closing` ainda recebem input normalmente.
 */
export const processedCycleStatuses = ["processing", "post_closing", "closed"] as const;

export function competenceOf(date: string) {
  return date.slice(0, 7);
}

export function retroactivityTitle(movementTitle: string, competence: string) {
  return `Retroativo em competência já processada (${competence}): lançar a diferença na folha — ${movementTitle}`.slice(0, 180);
}

