import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";
import { dateFromDatabase, optionalDate } from "./registrations.ts";

/**
 * Treinamentos obrigatórios (NR), passo 1.
 *
 * O nome do treinamento é texto livre — a mesma razão de
 * `positions.specialActivities` (0098): o produto não decide quais NRs
 * existem nem quais delas o cliente aplica.
 */

export type TrainingInput = {
  companyId: string;
  employeeId: string;
  trainingName: string;
  completedOn: string;
  validUntil: string | null;
  providerName: string;
  certificateNumber: string;
  notes: string;
};

/**
 * Criar e corrigir usam a mesma validação — a mesma razão de
 * `parseOccupationalExamInput`: se a correção fosse mais frouxa, bastaria
 * lançar certo e editar depois para gravar uma validade que o CHECK do banco
 * recusaria em qualquer outro caminho.
 */
export function parseTrainingInput(body: Record<string, unknown>): TrainingInput {
  const companyId = cleanText(body.companyId, 120);
  if (!companyId) throw ApiError.badRequest("Selecione a empresa do treinamento.", "TRAINING_COMPANY_REQUIRED");
  const employeeId = cleanText(body.employeeId, 120);
  if (!employeeId) throw ApiError.badRequest("Selecione o colaborador do treinamento.", "TRAINING_EMPLOYEE_REQUIRED");
  const trainingName = cleanText(body.trainingName, 160);
  if (!trainingName) throw ApiError.badRequest("Informe o nome do treinamento.", "TRAINING_NAME_REQUIRED");
  const completedOn = optionalDate(body.completedOn, true);
  if (!completedOn) throw ApiError.badRequest("Informe a data de conclusão.", "TRAINING_DATE_REQUIRED");
  // Margem de um dia pelo mesmo motivo do exame ocupacional: o servidor conta
  // em UTC e o Brasil inteiro está atrás dele.
  const limit = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (completedOn > limit) throw ApiError.badRequest("A conclusão não pode estar no futuro.", "TRAINING_DATE_IN_FUTURE");

  const validUntil = Object.hasOwn(body, "validUntil") ? optionalDate(body.validUntil) : null;
  if (validUntil && validUntil < completedOn) {
    throw ApiError.badRequest("A validade não pode terminar antes da conclusão.", "TRAINING_VALIDITY_BEFORE_COMPLETION");
  }

  return {
    companyId, employeeId, trainingName, completedOn, validUntil,
    providerName: cleanText(body.providerName, 160),
    certificateNumber: cleanText(body.certificateNumber, 80),
    notes: cleanText(body.notes, 1000),
  };
}

export type TrainingRecord = TrainingInput & { id: string; createdAt: string; updatedAt: string };

const asText = (value: unknown) => value == null ? "" : String(value);

export function trainingFromRow(row: Record<string, unknown>): TrainingRecord {
  return {
    id: asText(row.id),
    companyId: asText(row.company_id),
    employeeId: asText(row.employee_id),
    trainingName: asText(row.training_name),
    completedOn: dateFromDatabase(row.completed_on, "Data de conclusão") ?? "",
    validUntil: row.valid_until ? dateFromDatabase(row.valid_until, "Validade") : null,
    providerName: asText(row.provider_name),
    certificateNumber: asText(row.certificate_number),
    notes: asText(row.notes),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
  };
}

export type TrainingStatus = "valid" | "expiring" | "expired" | "no_expiry";

/**
 * A mesma régua de `epi_ca_expiry` (§4.3): vencido, vencendo em até 60 dias,
 * ou no prazo. Treinamento sem validade (onboarding, integração) não vence —
 * `no_expiry` não é um estado de urgência, é a ausência dele.
 */
export function trainingStatus(validUntil: string | null, today = new Date().toISOString().slice(0, 10)): TrainingStatus {
  if (!validUntil) return "no_expiry";
  if (validUntil < today) return "expired";
  const limit = new Date(new Date(today).getTime() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return validUntil <= limit ? "expiring" : "valid";
}
