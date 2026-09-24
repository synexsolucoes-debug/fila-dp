import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";
import { dateFromDatabase, optionalDate } from "./registrations.ts";

/**
 * Controle de exames ocupacionais (ASO), passo 1.
 *
 * A mesma fronteira já praticada em Psicologia
 * (tests/psychology-clinical-boundary.test.mts): resultado e restrição
 * funcional entram, diagnóstico não. `result` é fechado em
 * apto/inapto/apto com restrição — nunca a doença ou o exame clínico que
 * levou à conclusão. `restrictionNotes` descreve a restrição de função
 * ("não pode carregar peso acima de 10kg"), não a causa clínica dela.
 */

export const examTypes = ["admission", "periodic", "return_to_work", "role_change", "termination", "other"] as const;
export type ExamType = typeof examTypes[number];

export const examTypeLabels: Record<ExamType, string> = {
  admission: "Admissional",
  periodic: "Periódico",
  return_to_work: "Retorno ao trabalho",
  role_change: "Mudança de função",
  termination: "Demissional",
  other: "Outro",
};

export const examResults = ["fit", "unfit", "fit_with_restriction"] as const;
export type ExamResult = typeof examResults[number];

export const examResultLabels: Record<ExamResult, string> = {
  fit: "Apto",
  unfit: "Inapto",
  fit_with_restriction: "Apto com restrição",
};

const clinicalDataPattern = /diagn[oó]stico|prontu[aá]rio|\bcid\b|medica[cç][aã]o|nota cl[ií]nica|paciente|sintoma|doen[cç]a|patologia/u;

/** A mesma guarda de Psicologia, aplicada aos campos livres do exame ocupacional. */
export function assertNoClinicalData(...values: unknown[]) {
  if (clinicalDataPattern.test(JSON.stringify(values).toLowerCase())) {
    throw ApiError.badRequest("Dados clínicos não podem ser armazenados neste módulo.", "CLINICAL_DATA_FORBIDDEN");
  }
}

export type OccupationalExamInput = {
  companyId: string;
  employeeId: string;
  examType: ExamType;
  examDate: string;
  result: ExamResult;
  restrictionNotes: string;
  nextDueDate: string | null;
  clinicName: string;
  doctorName: string;
  notes: string;
};

function examEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, code: string): T {
  const candidate = cleanText(value, 40);
  if (!allowed.includes(candidate as T)) throw ApiError.badRequest(`${field} inválido.`, code);
  return candidate as T;
}

/**
 * Criar e corrigir usam a mesma validação — a mesma razão de
 * `parseWorkAccidentInput`: se a correção fosse mais frouxa, bastaria
 * lançar certo e editar depois para gravar um resultado que o CHECK do
 * banco recusaria em qualquer outro caminho.
 */
export function parseOccupationalExamInput(body: Record<string, unknown>): OccupationalExamInput {
  const companyId = cleanText(body.companyId, 120);
  if (!companyId) throw ApiError.badRequest("Selecione a empresa do exame.", "EXAM_COMPANY_REQUIRED");
  const employeeId = cleanText(body.employeeId, 120);
  if (!employeeId) throw ApiError.badRequest("Selecione o colaborador do exame.", "EXAM_EMPLOYEE_REQUIRED");
  const examDate = optionalDate(body.examDate, true);
  if (!examDate) throw ApiError.badRequest("Informe a data do exame.", "EXAM_DATE_REQUIRED");
  // Margem de um dia pelo mesmo motivo de acidente de trabalho: o servidor
  // conta em UTC e o Brasil inteiro está atrás dele.
  const limit = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (examDate > limit) throw ApiError.badRequest("A data do exame não pode estar no futuro.", "EXAM_DATE_IN_FUTURE");

  const result = examEnum<ExamResult>(body.result, examResults, "Resultado do exame", "EXAM_INVALID_RESULT");
  const restrictionNotes = cleanText(body.restrictionNotes, 500);
  if (restrictionNotes && result !== "fit_with_restriction") {
    throw ApiError.badRequest(
      "A restrição funcional só pode ser informada quando o resultado é apto com restrição.",
      "EXAM_RESTRICTION_WITHOUT_RESULT",
    );
  }
  const nextDueDate = Object.hasOwn(body, "nextDueDate") ? optionalDate(body.nextDueDate) : null;
  const notes = cleanText(body.notes, 1000);
  assertNoClinicalData(restrictionNotes, notes);

  return {
    companyId, employeeId,
    examType: examEnum<ExamType>(body.examType, examTypes, "Tipo do exame", "EXAM_INVALID_TYPE"),
    examDate, result, restrictionNotes, nextDueDate,
    clinicName: cleanText(body.clinicName, 160),
    doctorName: cleanText(body.doctorName, 160),
    notes,
  };
}

export type OccupationalExamRecord = OccupationalExamInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

const asText = (value: unknown) => value == null ? "" : String(value);

export function occupationalExamFromRow(row: Record<string, unknown>): OccupationalExamRecord {
  return {
    id: asText(row.id),
    companyId: asText(row.company_id),
    employeeId: asText(row.employee_id),
    examType: asText(row.exam_type) as ExamType,
    examDate: dateFromDatabase(row.exam_date, "Data do exame") ?? "",
    result: asText(row.result) as ExamResult,
    restrictionNotes: asText(row.restriction_notes),
    nextDueDate: row.next_due_date ? dateFromDatabase(row.next_due_date, "Próximo vencimento") : null,
    clinicName: asText(row.clinic_name),
    doctorName: asText(row.doctor_name),
    notes: asText(row.notes),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
  };
}
