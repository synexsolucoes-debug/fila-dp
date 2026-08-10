import { ApiError } from "./api-errors.ts";
import { cleanText, optionalDate } from "./registrations.ts";

export const movementTypes = ["salary_change", "vacation", "leave", "termination", "transfer", "benefit_change", "registration_sync", "other"] as const;
export const cycleStatuses = ["open", "pre_closing", "processing", "post_closing", "closed"] as const;
export const workItemStatuses = ["pending", "in_progress", "blocked", "completed"] as const;
export const obligationTypes = ["payroll", "social_security", "tax", "reporting", "union", "other"] as const;

export function validCompetence(value: unknown) {
  const competence = cleanText(value, 7);
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(competence)) throw ApiError.badRequest("Competência inválida. Use AAAA-MM.", "INVALID_COMPETENCE");
  return competence;
}

export function validRequiredDate(value: unknown) {
  const date = optionalDate(value, true);
  if (!date) throw ApiError.badRequest("Informe uma data válida.", "INVALID_DATE");
  return date;
}

export function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function sanitizeMovementDetails(type: typeof movementTypes[number], value: unknown) {
  const input = objectValue(value);
  const date = (key: string) => Object.hasOwn(input, key) ? optionalDate(input[key]) : null;
  if (type === "salary_change") return {
    reason: cleanText(input.reason, 300),
    percentage: Math.max(-100, Math.min(1000, Number(input.percentage) || 0)),
    newSalary: Math.max(0, Math.min(999999999, Number(input.newSalary) || 0)),
  };
  if (type === "vacation") return { startDate: date("startDate"), endDate: date("endDate"), days: Math.max(1, Math.min(90, Number(input.days) || 30)) };
  if (type === "leave") return { startDate: date("startDate"), endDate: date("endDate"), reasonCode: cleanText(input.reasonCode, 40) };
  if (type === "termination") return { terminationType: cleanText(input.terminationType, 60), lastWorkingDate: date("lastWorkingDate") };
  if (type === "transfer") return { targetCompanyId: cleanText(input.targetCompanyId, 120), departmentId: cleanText(input.departmentId, 120), positionId: cleanText(input.positionId, 120), costCenterId: cleanText(input.costCenterId, 120) };
  if (type === "benefit_change") return { benefit: cleanText(input.benefit, 100), action: cleanText(input.action, 40), reference: cleanText(input.reference, 160) };
  if (type === "registration_sync") return { sourceSystem: input.sourceSystem === "solides" ? "solides" : "manual", externalId: cleanText(input.externalId, 160), fields: Array.isArray(input.fields) ? input.fields.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 30) : [] };
  return { description: cleanText(input.description, 1000) };
}

export function sanitizeProcessConfiguration(value: unknown) {
  const input = objectValue(value);
  const steps = Array.isArray(input.steps) ? input.steps.slice(0, 30).map((raw, index) => {
    const step = objectValue(raw);
    const key = cleanText(step.key, 60).toLowerCase().replace(/[^a-z0-9_-]/g, "-") || `step-${index + 1}`;
    return { key, name: cleanText(step.name, 120) || `Etapa ${index + 1}`, gate: Boolean(step.gate), slaDays: Math.max(0, Math.min(60, Number(step.slaDays) || 0)) };
  }) : [];
  const stepKeys = new Set(steps.map((step) => step.key));
  if (stepKeys.size !== steps.length) throw ApiError.badRequest("As etapas precisam de identificadores únicos.", "DUPLICATE_PROCESS_STEP");
  const transitions = Array.isArray(input.transitions) ? input.transitions.slice(0, 100).flatMap((raw) => {
    const transition = objectValue(raw);
    const from = cleanText(transition.from, 60);
    const to = cleanText(transition.to, 60);
    return stepKeys.has(from) && stepKeys.has(to) && from !== to ? [{ from, to }] : [];
  }) : [];
  return { steps, transitions, approvalRequired: Boolean(input.approvalRequired), checklist: Array.isArray(input.checklist) ? input.checklist.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, 40) : [] };
}

export function assertNoAdmissionWorkflow(...values: unknown[]) {
  const haystack = values.map((value) => cleanText(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()).join(" ");
  if (/\badmissao\b|\badmissional\b/.test(haystack)) {
    throw ApiError.badRequest("A admissão digital é executada na Sólides. No Vinculato, use conciliação cadastral para dados já concluídos.", "SOLIDES_ADMISSION_BOUNDARY");
  }
}

export function publicMovement<T extends Record<string, unknown>>(movement: T, includeDetails: boolean) {
  const safe: Record<string, unknown> = { ...movement };
  if (!includeDetails) delete safe.details_json;
  return safe;
}
