import { ApiError } from "./api-errors.ts";
import { dateFromDatabase } from "./registrations.ts";

/**
 * Histórico funcional — a ficha do colaborador com data de validade.
 *
 * Engenharia reversa do Personnel Administration do SAP HCM
 * (docs/engenharia-reversa-sap-hcm.md): lá o cadastro mestre não é uma linha
 * que se sobrescreve, é uma sequência de registros (infotipos) com `BEGDA` e
 * `ENDDA`. "Onde o colaborador está" é sempre uma pergunta com data — e é essa
 * pergunta que o Vinculato não sabia responder: `fdp_employees` guarda só o
 * agora, e aplicar uma transferência apagava o departamento anterior.
 *
 * Três tipos de registro, cada um espelhando um infotipo:
 *
 * - `situation`  ↔ IT0000 (Medidas): ativo, afastado, desligado;
 * - `assignment` ↔ IT0001 (Atribuição organizacional): empresa, unidade,
 *   departamento, cargo e centro de custo;
 * - `schedule`   ↔ IT0007 (Horário de trabalho teórico): a jornada.
 *
 * Todos seguem a restrição temporal 1 do SAP: em qualquer dia entre o início
 * do histórico e `9999-12-31` existe exatamente um registro vigente, sem
 * buraco e sem sobreposição. Um registro novo **delimita** o que estava
 * vigente na véspera — nunca o apaga.
 *
 * O salário (infotipo 0008) não mora aqui: tem tabela própria, com
 * vigência, em `fdp_employee_remuneration` (lib/remuneration.ts).
 *
 * Este arquivo é puro: não acessa banco nem sessão.
 */

/** A "data alta" do SAP: o registro vale até segunda ordem. */
export const HIGH_DATE = "9999-12-31";

export const historyRecordTypes = ["situation", "assignment", "schedule"] as const;
export type HistoryRecordType = typeof historyRecordTypes[number];

export const historyRecordTypeLabels: Record<HistoryRecordType, string> = {
  situation: "Situação do vínculo",
  assignment: "Lotação",
  schedule: "Jornada",
};

/**
 * O motivo do registro — a "medida" do SAP. `baseline` é a fotografia do
 * cadastro no dia em que o histórico começou a existir para a pessoa: o que
 * houve antes disso não foi registrado, e a tela diz isso por escrito.
 */
export const historyReasons = ["baseline", "leave", "return_to_work", "termination", "transfer", "registration_edit", "integration_sync"] as const;
export type HistoryReason = typeof historyReasons[number];

export const historyReasonLabels: Record<HistoryReason, string> = {
  baseline: "Situação na implantação do histórico",
  leave: "Afastamento",
  return_to_work: "Retorno de afastamento",
  termination: "Desligamento",
  transfer: "Transferência",
  registration_edit: "Alteração no cadastro",
  integration_sync: "Sincronização com a origem (Sankhya)",
};

export type EmploymentStatus = "active" | "on_leave" | "terminated";

/** Os campos que cada tipo carrega. Os demais ficam nulos no registro. */
export type HistoryValues = {
  employmentStatus: EmploymentStatus | null;
  companyId: string | null;
  establishmentId: string | null;
  departmentId: string | null;
  positionId: string | null;
  costCenterId: string | null;
  workScheduleId: string | null;
};

export const historyFieldsByType: Record<HistoryRecordType, readonly (keyof HistoryValues)[]> = {
  situation: ["employmentStatus"],
  assignment: ["companyId", "establishmentId", "departmentId", "positionId", "costCenterId"],
  schedule: ["workScheduleId"],
};

export type HistoryRecord = HistoryValues & {
  id: string;
  recordType: HistoryRecordType;
  validFrom: string;
  validTo: string;
  reason: HistoryReason;
  movementId: string | null;
};

const emptyValues: HistoryValues = {
  employmentStatus: null, companyId: null, establishmentId: null, departmentId: null,
  positionId: null, costCenterId: null, workScheduleId: null,
};

/** Só os campos do tipo; o resto zera, para o CHECK do banco não ser a primeira barreira. */
export function valuesForType(type: HistoryRecordType, source: Partial<HistoryValues>): HistoryValues {
  const values: HistoryValues = { ...emptyValues };
  for (const field of historyFieldsByType[type]) {
    (values as Record<string, unknown>)[field] = source[field] ?? null;
  }
  return values;
}

export function sameValues(type: HistoryRecordType, left: Partial<HistoryValues>, right: Partial<HistoryValues>) {
  return historyFieldsByType[type].every((field) => (left[field] ?? null) === (right[field] ?? null));
}

/** Véspera de uma data AAAA-MM-DD, em UTC para não depender do fuso do servidor. */
export function previousDay(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

export function nextDay(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Quando a situação "desligado" começa. A data de desligamento do DP é o
 * último dia do vínculo — a pessoa ainda está ativa nela —, então o registro
 * novo começa no dia seguinte, como a medida de desligamento do SAP.
 */
export function terminatedFrom(terminationDate: string) {
  return nextDay(terminationDate);
}

/** "Hoje" no Brasil: o servidor conta em UTC e o país inteiro está atrás dele. */
export function todayInBrazil(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** O registro vigente na data, ou `null` antes do início do histórico. */
export function recordAt(records: readonly HistoryRecord[], type: HistoryRecordType, date: string) {
  return records.find((record) => record.recordType === type && record.validFrom <= date && date <= record.validTo) ?? null;
}

/**
 * A fotografia da pessoa numa data-base — o "dia-chave" dos relatórios do
 * SAP. Cada tipo responde sozinho: um colaborador pode ter lotação registrada
 * e jornada ainda não.
 */
export function snapshotAt(records: readonly HistoryRecord[], date: string) {
  return Object.fromEntries(historyRecordTypes.map((type) => [type, recordAt(records, type, date)])) as
    Record<HistoryRecordType, HistoryRecord | null>;
}

/**
 * Prova da restrição temporal 1: por tipo, os registros encostam um no outro
 * (o fim de um é a véspera do início do próximo) e o último vale até a data
 * alta. Usado pelos testes e pela rota de leitura, que avisa em vez de
 * esconder um histórico quebrado.
 */
export function timelineGaps(records: readonly HistoryRecord[]) {
  const problems: string[] = [];
  for (const type of historyRecordTypes) {
    const ordered = records.filter((record) => record.recordType === type).sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    ordered.forEach((record, index) => {
      if (record.validTo < record.validFrom) problems.push(`${type}: ${record.id} termina antes de começar`);
      const next = ordered[index + 1];
      if (next && previousDay(next.validFrom) !== record.validTo) problems.push(`${type}: ${record.validTo} → ${next.validFrom}`);
      if (!next && record.validTo !== HIGH_DATE) problems.push(`${type}: último registro termina em ${record.validTo}`);
    });
  }
  return problems;
}

/**
 * O que gravar para registrar uma mudança com data de início — a operação
 * "copiar e delimitar" do PA30 do SAP.
 *
 * - Sem histórico do tipo: nasce a linha de base com o cadastro **antes** da
 *   mudança, da admissão até a véspera; depois o registro novo. Se a mudança
 *   começa na admissão (ou antes dela), não há "antes" a fotografar.
 * - Com histórico: o registro vigente na data é delimitado na véspera e o novo
 *   herda o fim dele — então uma mudança retroativa não atropela as que vieram
 *   depois, só ocupa o intervalo que era do registro delimitado.
 * - Mudança que começa no mesmo dia do registro vigente substitui os valores
 *   dele, como o SAP faz com dois registros de mesmo `BEGDA`.
 * - Mudança que não muda nada não grava nada.
 *
 * `changes` é parcial: uma transferência que só troca o cargo herda o
 * departamento e o centro de custo do registro delimitado.
 */
export type HistoryPlan =
  | { kind: "noop" }
  | {
      kind: "write";
      baseline: { validFrom: string; validTo: string; values: HistoryValues } | null;
      delimit: { id: string; validTo: string; expectedValidTo: string } | null;
      replace: { id: string; values: HistoryValues } | null;
      insert: { validFrom: string; validTo: string; values: HistoryValues } | null;
    };

export function planHistoryChange(input: {
  records: readonly HistoryRecord[];
  type: HistoryRecordType;
  effectiveDate: string;
  changes: Partial<HistoryValues>;
  /** O cadastro como está agora — vira a linha de base se o tipo ainda não tem histórico. */
  current: Partial<HistoryValues>;
  admissionDate: string;
}): HistoryPlan {
  const { type, effectiveDate } = input;
  const ofType = input.records.filter((record) => record.recordType === type);

  if (!ofType.length) {
    const before = valuesForType(type, input.current);
    const after = valuesForType(type, { ...before, ...pickDefined(input.changes) });
    if (sameValues(type, before, after)) return { kind: "noop" };
    const hasBefore = effectiveDate > input.admissionDate;
    return {
      kind: "write",
      baseline: hasBefore ? { validFrom: input.admissionDate, validTo: previousDay(effectiveDate), values: before } : null,
      delimit: null,
      replace: null,
      insert: { validFrom: effectiveDate, validTo: HIGH_DATE, values: after },
    };
  }

  const covering = ofType.find((record) => record.validFrom <= effectiveDate && effectiveDate <= record.validTo);
  if (!covering) {
    throw new ApiError(409, "HISTORY_BEFORE_START",
      "A data informada é anterior ao início do histórico funcional deste colaborador.");
  }
  const after = valuesForType(type, { ...covering, ...pickDefined(input.changes) });
  if (sameValues(type, covering, after)) return { kind: "noop" };

  if (covering.validFrom === effectiveDate) {
    return { kind: "write", baseline: null, delimit: null, replace: { id: covering.id, values: after }, insert: null };
  }
  return {
    kind: "write",
    baseline: null,
    delimit: { id: covering.id, validTo: previousDay(effectiveDate), expectedValidTo: covering.validTo },
    replace: null,
    insert: { validFrom: effectiveDate, validTo: covering.validTo, values: after },
  };
}

function pickDefined(changes: Partial<HistoryValues>) {
  return Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<HistoryValues>;
}

const asText = (value: unknown) => value == null ? "" : String(value);
const nullable = (value: unknown) => value == null || value === "" ? null : String(value);

export function historyRecordFromRow(row: Record<string, unknown>): HistoryRecord {
  return {
    id: asText(row.id),
    recordType: asText(row.record_type) as HistoryRecordType,
    validFrom: dateFromDatabase(row.valid_from, "Início da validade") ?? "",
    validTo: dateFromDatabase(row.valid_to, "Fim da validade") ?? HIGH_DATE,
    reason: asText(row.reason) as HistoryReason,
    movementId: nullable(row.movement_id),
    employmentStatus: nullable(row.employment_status) as EmploymentStatus | null,
    companyId: nullable(row.company_id),
    establishmentId: nullable(row.establishment_id),
    departmentId: nullable(row.department_id),
    positionId: nullable(row.position_id),
    costCenterId: nullable(row.cost_center_id),
    workScheduleId: nullable(row.work_schedule_id),
  };
}

/** O cadastro atual (`fdp_employees`) no vocabulário do histórico. */
export function currentValuesFromEmployee(row: Record<string, unknown>): HistoryValues {
  return {
    employmentStatus: nullable(row.employment_status) as EmploymentStatus | null,
    companyId: nullable(row.company_id),
    establishmentId: nullable(row.establishment_id),
    departmentId: nullable(row.department_id),
    positionId: nullable(row.position_id),
    costCenterId: nullable(row.cost_center_id),
    workScheduleId: nullable(row.work_schedule_id),
  };
}

/**
 * Onde o cadastro de hoje discorda do registro vigente hoje no histórico.
 *
 * Acontece por desenho em dois casos, e a tela precisa dizer qual: uma
 * movimentação aplicada com data futura (o cadastro já mudou, a validade
 * ainda não começou) e uma alteração feita antes de o histórico existir.
 */
export function divergencesAt(records: readonly HistoryRecord[], current: HistoryValues, date: string) {
  const result: Array<{ recordType: HistoryRecordType; field: keyof HistoryValues; history: string | null; current: string | null }> = [];
  for (const type of historyRecordTypes) {
    const record = recordAt(records, type, date);
    if (!record) continue;
    for (const field of historyFieldsByType[type]) {
      if ((record[field] ?? null) !== (current[field] ?? null)) {
        result.push({ recordType: type, field, history: record[field] ?? null, current: current[field] ?? null });
      }
    }
  }
  return result;
}
