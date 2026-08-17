import { ApiError } from "./api-errors.ts";
import { cleanText, optionalDate } from "./registrations.ts";

export const movementTypes = ["salary_change", "vacation", "leave", "termination", "transfer", "benefit_change", "registration_sync", "epi_discount", "other"] as const;
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
  if (type === "epi_discount") return {
    discountRequestId: cleanText(input.discountRequestId, 120), cardId: cleanText(input.cardId, 120),
    competence: cleanText(input.competence, 7), originalValue: Math.max(0, Number(input.originalValue) || 0),
    approvedValue: Math.max(0, Number(input.approvedValue) || 0),
    note: cleanText(input.note, 1000), automaticDeduction: false,
  };
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

/**
 * O que está impedindo o fechamento da competência (§22).
 *
 * Os portões de fechamento ficam dentro do `WHERE` do UPDATE, e isso é
 * deliberado: verificar antes e atualizar depois abriria janela para uma
 * movimentação entrar entre as duas coisas. O efeito colateral era a resposta
 * saber apenas que *algo* barrou — o usuário recebia "a competência possui
 * bloqueadores, aprovações ou obrigações pendentes" e ficava sem saber o quê,
 * onde, nem quantos.
 *
 * Esta consulta roda só depois do bloqueio, para explicá-lo. Ela não substitui
 * os portões nem serve de pré-checagem: é diagnóstico, não autorização.
 */
export type ClosingBlocker = { kind: string; label: string; total: number; examples: string[] };

type BlockerRow = Record<string, unknown>;

const blockerLabels: Record<string, { one: string; many: string }> = {
  pending: { one: "pendência bloqueante em aberto", many: "pendências bloqueantes em aberto" },
  movements: { one: "movimentação não aprovada", many: "movimentações não aprovadas" },
  items: { one: "etapa do fechamento não concluída", many: "etapas do fechamento não concluídas" },
  obligations: { one: "obrigação não concluída", many: "obrigações não concluídas" },
  auxiliary: { one: "execução auxiliar em aberto", many: "execuções auxiliares em aberto" },
};

const asExamples = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).slice(0, 3);
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try { return (JSON.parse(value) as unknown[]).map((item) => String(item)).filter(Boolean).slice(0, 3); } catch { return []; }
  }
  return [];
};

export async function describeClosingBlockers(
  d1: { prepare: (query: string) => { bind: (...args: unknown[]) => { first: <T>() => Promise<T | null> } } },
  workspaceId: string,
  cycleId: string,
  target: string,
): Promise<ClosingBlocker[]> {
  const row = await d1.prepare(`WITH pending AS (
      SELECT title FROM fdp_operational_pending_items
      WHERE workspace_id = $1 AND payroll_cycle_id = $2 AND blocking = 1 AND status IN ('open', 'in_progress')
    ), movements AS (
      SELECT title FROM fdp_employee_movements
      WHERE workspace_id = $1 AND payroll_cycle_id = $2 AND status IN ('draft', 'pending_approval', 'rejected')
    ), items AS (
      SELECT title FROM fdp_payroll_cycle_items
      WHERE workspace_id = $1 AND payroll_cycle_id = $2 AND status <> 'completed'
    ), obligations AS (
      SELECT title FROM fdp_compliance_obligations
      WHERE workspace_id = $1 AND payroll_cycle_id = $2 AND status <> 'completed'
    ), auxiliary AS (
      SELECT title FROM fdp_auxiliary_executions
      WHERE workspace_id = $1 AND payroll_cycle_id = $2 AND status NOT IN ('closed', 'canceled')
    )
    SELECT
      (SELECT count(*) FROM pending)::int AS pending_total,
      (SELECT json_agg(title) FROM (SELECT title FROM pending ORDER BY title LIMIT 3) t) AS pending_examples,
      (SELECT count(*) FROM movements)::int AS movements_total,
      (SELECT json_agg(title) FROM (SELECT title FROM movements ORDER BY title LIMIT 3) t) AS movements_examples,
      (SELECT count(*) FROM items)::int AS items_total,
      (SELECT json_agg(title) FROM (SELECT title FROM items ORDER BY title LIMIT 3) t) AS items_examples,
      (SELECT count(*) FROM obligations)::int AS obligations_total,
      (SELECT json_agg(title) FROM (SELECT title FROM obligations ORDER BY title LIMIT 3) t) AS obligations_examples,
      (SELECT count(*) FROM auxiliary)::int AS auxiliary_total,
      (SELECT json_agg(title) FROM (SELECT title FROM auxiliary ORDER BY title LIMIT 3) t) AS auxiliary_examples`)
    .bind(workspaceId, cycleId)
    .first<BlockerRow>();
  if (!row) return [];

  // Sair de `pre_closing` só depende de pendência e movimentação; as demais
  // barreiras existem apenas no fechamento. Listar o que ainda não vale seria
  // mandar o usuário resolver algo que não o está impedindo agora.
  const kinds = target === "closed"
    ? ["pending", "movements", "items", "obligations", "auxiliary"]
    : ["pending", "movements"];

  return kinds.flatMap((kind) => {
    const total = Number(row[`${kind}_total`] ?? 0);
    if (!total) return [];
    const labels = blockerLabels[kind];
    return [{ kind, label: total === 1 ? labels.one : labels.many, total, examples: asExamples(row[`${kind}_examples`]) }];
  });
}

/** Frase que nomeia o que barrou, em vez de dizer que "algo" barrou. */
export function closingBlockerMessage(blockers: ClosingBlocker[]) {
  if (!blockers.length) {
    // O bloqueio existiu, mas nada aparece no diagnóstico: outra pessoa mexeu na
    // competência entre a tentativa e a explicação. Dizer isso é mais honesto do
    // que listar zero motivos.
    return "A competência mudou enquanto a transição era aplicada. Recarregue e tente novamente.";
  }
  const parts = blockers.map((blocker) => {
    const examples = blocker.examples.length ? ` (${blocker.examples.join("; ")}${blocker.total > blocker.examples.length ? "…" : ""})` : "";
    return `${blocker.total} ${blocker.label}${examples}`;
  });
  return `Não é possível avançar a competência: ${parts.join(", ")}. Resolva esses itens e tente novamente.`;
}

/**
 * Evidência da obrigação: link para o comprovante, não o arquivo.
 *
 * Recusa o que não for http(s) — `javascript:` gravado aqui viraria execução no
 * clique de quem abrisse a evidência a partir da lista, e o `CHECK` do banco
 * sozinho daria um erro de constraint em vez de uma frase que ajuda.
 */
export function validEvidenceUrl(value: unknown) {
  const raw = cleanText(value, 2000);
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest("A evidência precisa ser um endereço completo, começando com https://.", "INVALID_EVIDENCE_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw ApiError.badRequest("A evidência precisa ser um endereço http ou https.", "INVALID_EVIDENCE_URL");
  }
  // Credencial na URL acabaria no corpo da resposta e no log de auditoria.
  if (url.username || url.password) {
    throw ApiError.badRequest("Não use usuário e senha no endereço da evidência.", "INVALID_EVIDENCE_URL");
  }
  return url.toString();
}
