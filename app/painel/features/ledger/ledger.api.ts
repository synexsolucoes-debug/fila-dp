import type {
  LedgerAdvanceDraft, LedgerCompanyOption, LedgerEntry, LedgerEntryDetail,
  LedgerEntryDraft, LedgerInstallment, LedgerOverview, LedgerPersonOption,
} from "./ledger.types";

/**
 * Conversa da tela com `/api/payroll-ledger`.
 *
 * O servidor devolve os lançamentos já traduzidos — `ledgerEntryFromRow` roda
 * lá —, então aqui só sobra transporte, erro legível e a montagem do corpo que
 * o formulário envia.
 *
 * Dinheiro sai daqui como **texto**, do jeito que foi digitado ("1.234,56"). A
 * conversão para centavos acontece no servidor, em um lugar só. Converter no
 * navegador significaria duas implementações do mesmo arredondamento, e a hora
 * em que elas discordassem seria a hora em que o saldo de alguém ficasse errado.
 */
type Row = Record<string, unknown>;

const text = (input: unknown) => input == null ? "" : String(input);
const bool = (input: unknown) => input === true || input === 1 || input === "1" || input === "true";
const num = (input: unknown) => {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : 0;
};
const numOrNull = (input: unknown) => {
  if (input === null || input === undefined || input === "") return null;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function normalizeCompany(row: Row): LedgerCompanyOption {
  return {
    id: text(row.id),
    name: text(row.trade_name ?? row.tradeName) || text(row.legal_name ?? row.legalName),
    taxId: text(row.tax_id ?? row.taxId),
    status: row.status === "inactive" ? "inactive" : "active",
  };
}

export function normalizeOverview(payload: Row): LedgerOverview {
  const permissions = (payload.permissions ?? {}) as Row;
  const summary = (payload.summary ?? {}) as Row;
  return {
    permissions: {
      read: bool(permissions.read),
      request: bool(permissions.request),
      manage: bool(permissions.manage),
      approve: bool(permissions.approve),
      pay: bool(permissions.pay),
      confirm: bool(permissions.confirm),
      reverse: bool(permissions.reverse),
      override: bool(permissions.override),
      reschedule: bool(permissions.reschedule),
      import: bool(permissions.import),
      export: bool(permissions.export),
      close: bool(permissions.close),
      reopen: bool(permissions.reopen),
    },
    companies: Array.isArray(payload.companies) ? (payload.companies as Row[]).map(normalizeCompany) : [],
    competences: Array.isArray(payload.competences)
      ? (payload.competences as Row[]).map((row) => ({
        id: text(row.id), companyId: text(row.company_id ?? row.companyId),
        competence: text(row.competence), status: text(row.status),
      }))
      : [],
    areas: Array.isArray(payload.areas)
      ? (payload.areas as Row[]).map((row) => ({ id: text(row.id), name: text(row.name), code: text(row.code) }))
      : [],
    summary: {
      entries: num(summary.entries),
      awaitingApproval: num(summary.awaitingApproval),
      plannedTotal: num(summary.plannedTotal),
      discountedTotal: num(summary.discountedTotal),
      remainingTotal: num(summary.remainingTotal),
    },
  };
}

export async function loadOverview(companyId: string): Promise<LedgerOverview> {
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  return normalizeOverview(await requestJson<Row>(`/api/payroll-ledger/overview${query}`));
}

export type LedgerFilters = {
  companyId: string;
  employeeId: string;
  category: string;
  status: string;
  requesterAreaId: string;
  openOnly: boolean;
};

export async function loadEntries(filters: LedgerFilters): Promise<{ entries: LedgerEntry[]; truncated: boolean }> {
  const query = new URLSearchParams();
  if (filters.companyId) query.set("companyId", filters.companyId);
  if (filters.employeeId) query.set("employeeId", filters.employeeId);
  if (filters.category) query.set("category", filters.category);
  if (filters.status) query.set("status", filters.status);
  if (filters.requesterAreaId) query.set("requesterAreaId", filters.requesterAreaId);
  if (filters.openOnly) query.set("open", "true");
  const suffix = query.toString() ? `?${query}` : "";
  const payload = await requestJson<{ entries: LedgerEntry[]; truncated?: boolean }>(`/api/payroll-ledger/entries${suffix}`);
  return { entries: payload.entries ?? [], truncated: Boolean(payload.truncated) };
}

export async function loadEntryDetail(id: string): Promise<LedgerEntryDetail> {
  const payload = await requestJson<Row>(`/api/payroll-ledger/entries/${encodeURIComponent(id)}`);
  return {
    entry: payload.entry as LedgerEntry,
    installments: (payload.installments ?? []) as LedgerEntryDetail["installments"],
    confirmations: Array.isArray(payload.confirmations)
      ? (payload.confirmations as Row[]).map((row) => ({
        id: text(row.id), installmentId: text(row.installment_id), competence: text(row.competence),
        amount: num(row.amount), kind: text(row.kind) as "confirmation" | "reversal" | "authorized_override",
        source: text(row.source), reference: text(row.reference), justification: text(row.justification),
        reversesConfirmationId: text(row.reverses_confirmation_id),
        confirmedBy: text(row.confirmed_by), confirmedByName: text(row.confirmed_by_name),
        confirmedAt: text(row.confirmed_at),
      }))
      : [],
    documents: Array.isArray(payload.documents)
      ? (payload.documents as Row[]).map((row) => ({
        id: text(row.id), documentKind: text(row.document_kind), filename: text(row.filename),
        contentType: text(row.content_type), sizeBytes: num(row.size_bytes),
        createdBy: text(row.created_by), createdAt: text(row.created_at),
      }))
      : [],
    events: Array.isArray(payload.events)
      ? (payload.events as Row[]).map((row) => ({
        id: text(row.id), installmentId: text(row.installment_id), eventType: text(row.event_type),
        summary: text(row.summary), actorUserId: text(row.actor_user_id),
        actorName: text(row.actor_name), createdAt: text(row.created_at),
      }))
      : [],
  };
}

/**
 * O corpo do lançamento.
 *
 * O recorrente não manda `totalAmount` nem `installmentCount` — não porque a
 * tela esconde os campos, mas porque eles não existem para essa modalidade. O
 * servidor recusa explicitamente um total em lançamento recorrente, e mandar
 * string vazia faria a recusa aparecer para quem não digitou nada.
 */
export function entryBody(draft: LedgerEntryDraft): Record<string, unknown> {
  const common = {
    companyId: draft.companyId,
    employeeId: draft.subjectKind === "employee" ? draft.employeeId : null,
    providerId: draft.subjectKind === "provider" ? draft.providerId : null,
    settlementTarget: draft.subjectKind === "provider" ? "contractor_payment" : "payroll",
    category: draft.category,
    title: draft.title,
    description: draft.description,
    reason: draft.reason,
    occurredOn: draft.occurredOn,
    requestedOn: draft.requestedOn,
    unitLabel: draft.unitLabel,
    operationLabel: draft.operationLabel,
    requesterAreaId: draft.requesterAreaId || null,
    modality: draft.modality,
    firstCompetence: draft.firstCompetence,
    details: draft.details,
  };
  if (draft.modality === "recurring") {
    return { ...common, recurrenceEndCompetence: draft.recurrenceEndCompetence };
  }
  return {
    ...common,
    totalAmount: draft.totalAmount,
    installmentCount: draft.modality === "single" ? 1 : draft.installmentCount,
  };
}

export async function createEntry(draft: LedgerEntryDraft): Promise<{ entry: { id: string } }> {
  return requestJson<{ entry: { id: string } }>("/api/payroll-ledger/entries", {
    method: "POST",
    body: JSON.stringify(entryBody(draft)),
  });
}

export async function updateEntry(id: string, patch: Record<string, unknown>) {
  return requestJson<Row>(`/api/payroll-ledger/entries/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function cancelEntry(id: string, canceledReason: string) {
  return updateEntry(id, { cancel: true, canceledReason });
}

export async function submitEntry(id: string, approverUserId: string) {
  return requestJson<Row>(`/api/payroll-ledger/entries/${encodeURIComponent(id)}/approval`, {
    method: "POST",
    body: JSON.stringify({ approverUserId }),
  });
}

export async function decideEntry(id: string, decision: "approve" | "reject", note: string) {
  return requestJson<Row>(`/api/payroll-ledger/entries/${encodeURIComponent(id)}/approval`, {
    method: "PATCH",
    body: JSON.stringify({ decision, note }),
  });
}

/**
 * Colaboradores da empresa, para o seletor.
 *
 * Vem da API de cadastros que já existe: o módulo não mantém lista própria de
 * pessoas, e um segundo cadastro de colaborador seria exatamente o projeto
 * paralelo que não se quer.
 *
 * A rota devolve no máximo 100 por vez, então o seletor pagina pelo cursor até
 * acabar. Carregar só a primeira página deixaria de fora quem estivesse na
 * segunda — e o efeito prático seria "não consigo lançar o desconto de fulano",
 * sem nada na tela explicando por quê.
 */
const EMPLOYEE_PAGE = 100;
const EMPLOYEE_CAP = 2000;

export async function loadEmployees(companyId: string): Promise<LedgerPersonOption[]> {
  if (!companyId) return [];
  const people: LedgerPersonOption[] = [];
  let cursor = "";
  while (people.length < EMPLOYEE_CAP) {
    const query = new URLSearchParams({ companyId, limit: String(EMPLOYEE_PAGE) });
    if (cursor) query.set("cursor", cursor);
    const payload = await requestJson<{ employees?: Row[]; nextCursor?: string | null }>(`/api/employees?${query}`);
    for (const row of payload.employees ?? []) {
      people.push({
        id: text(row.id),
        name: text(row.social_name) || text(row.full_name),
        registrationNumber: text(row.registration_number),
        departmentName: text(row.department_name),
        employmentStatus: text(row.employment_status),
      });
    }
    if (!payload.nextCursor) break;
    cursor = payload.nextCursor;
  }
  return people;
}

export function advanceBody(draft: LedgerAdvanceDraft): Record<string, unknown> {
  return {
    mode: draft.mode,
    fixedAmount: draft.mode === "percentage" ? "" : draft.fixedAmount,
    percentage: draft.mode === "percentage" ? draft.percentage : "",
    salaryBaseAmount: draft.mode === "percentage" ? draft.salaryBaseAmount : "",
    effectiveFromCompetence: draft.effectiveFromCompetence,
    endCompetence: draft.endCompetence,
    note: draft.note,
  };
}

export { numOrNull };

export type InstallmentFilters = {
  companyId: string;
  competence: string;
  overdue: boolean;
  category: string;
  status: string;
  settlementTarget: string;
};

export async function loadInstallments(filters: InstallmentFilters): Promise<{ installments: LedgerInstallment[]; truncated: boolean }> {
  const query = new URLSearchParams();
  if (filters.companyId) query.set("companyId", filters.companyId);
  if (filters.competence) query.set("competence", filters.competence);
  if (filters.overdue) query.set("overdue", "true");
  if (filters.category) query.set("category", filters.category);
  if (filters.status) query.set("status", filters.status);
  if (filters.settlementTarget) query.set("settlementTarget", filters.settlementTarget);
  const suffix = query.toString() ? `?${query}` : "";
  const payload = await requestJson<{ installments?: LedgerInstallment[]; truncated?: boolean }>(
    `/api/payroll-ledger/installments${suffix}`,
  );
  return { installments: payload.installments ?? [], truncated: Boolean(payload.truncated) };
}

/**
 * Confirmar, autorizar acima do saldo e estornar.
 *
 * O valor vai como texto digitado; a chave de idempotência é montada no
 * servidor a partir do que ele mesmo leu da parcela. Deixar o navegador
 * escolher a chave abriria a porta para duas confirmações diferentes
 * compartilharem a mesma — e uma delas sumir sem aviso.
 */
export async function confirmInstallment(id: string, input: {
  kind: "confirmation" | "authorized_override" | "reversal";
  amount: string;
  competence?: string;
  justification?: string;
  reference?: string;
  reversesConfirmationId?: string;
}) {
  return requestJson<Row>(`/api/payroll-ledger/installments/${encodeURIComponent(id)}/confirmations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateInstallment(id: string, input: {
  action: "reschedule" | "skip" | "anticipate" | "restore";
  competence?: string;
  justification: string;
}) {
  return requestJson<Row>(`/api/payroll-ledger/installments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function renegotiateEntry(id: string, input: {
  installmentCount: string;
  firstCompetence: string;
  reason: string;
  title?: string;
}) {
  return requestJson<Row>(`/api/payroll-ledger/entries/${encodeURIComponent(id)}/renegotiation`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
