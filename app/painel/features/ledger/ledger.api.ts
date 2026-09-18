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
    /* `recurringAmount` não é o total do lançamento — o banco recusa total em
       recorrente. Ele vira a primeira vigência do valor por competência, criada
       junto com o lançamento para que ele não nasça sem número. */
    return {
      ...common,
      recurrenceEndCompetence: draft.recurrenceEndCompetence,
      recurringAmount: draft.recurringAmount,
    };
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

export type LedgerAdvancePayment = {
  id: string;
  entryId: string;
  entryTitle: string;
  companyId: string;
  companyName: string;
  employeeId: string;
  employeeName: string;
  registrationNumber: string;
  unitLabel: string;
  departmentLabel: string;
  competence: string;
  approvedAmount: number;
  paidAmount: number;
  expectedPaymentDate: string;
  actualPaymentDate: string;
  status: "scheduled" | "pending_data" | "authorized" | "paid" | "canceled";
  pendingReason: string;
  cancelReason: string;
  recoveryPlannedAmount: number;
  recoveredAmount: number;
  recoveryCompetence: string;
  recoveryStatus: string;
};

export async function loadAdvancePayments(companyId: string, competence: string) {
  const query = new URLSearchParams();
  if (companyId) query.set("companyId", companyId);
  if (competence) query.set("competence", competence);
  const suffix = query.toString() ? `?${query}` : "";
  const payload = await requestJson<{ payments?: LedgerAdvancePayment[] }>(`/api/payroll-ledger/advance-payments${suffix}`);
  return payload.payments ?? [];
}

/**
 * Gera a programação mensal.
 *
 * A resposta traz a contagem que o servidor leu do banco depois de gravar, e
 * não o que o laço tentou inserir: com `ON CONFLICT DO NOTHING`, dizer "criei
 * 40" quando 38 já existiam seria mentir sobre o que aconteceu.
 */
export async function scheduleAdvances(companyId: string, competence: string, expectedPaymentDate: string) {
  return requestJson<{ scheduled: number; pending: number; skipped: string[]; message?: string }>(
    "/api/payroll-ledger/advance-payments",
    { method: "POST", body: JSON.stringify({ companyId, competence, expectedPaymentDate }) },
  );
}

export async function updateAdvancePayment(id: string, input: {
  action: "authorize" | "pay" | "cancel" | "resolve_pending";
  paidAmount?: string;
  approvedAmount?: string;
  actualPaymentDate?: string;
  recoveryCompetence?: string;
  cancelReason?: string;
}) {
  return requestJson<Row>(`/api/payroll-ledger/advance-payments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function createAdvanceRule(entryId: string, draft: LedgerAdvanceDraft) {
  return requestJson<{ pendingReason?: string }>(
    `/api/payroll-ledger/entries/${encodeURIComponent(entryId)}/advance-rules`,
    { method: "POST", body: JSON.stringify(advanceBody(draft)) },
  );
}

export type LedgerBatch = {
  id: string;
  status: string;
  competence: string;
  reopen_reason?: string;
  approved_by_name?: string;
  closed_by_name?: string;
  exported_at?: string | null;
};

export type LedgerCompetenceSummary = {
  scheduledCount: number;
  scheduledAmount: number;
  confirmedAmount: number;
  differenceAmount: number;
  openCount: number;
  overdueCount: number;
  overdueAmount: number;
  futureCount: number;
  futureAmount: number;
  entriesWithoutApproval: number;
  advanceExpectedAmount: number;
  advancePaidAmount: number;
  advancePendingCount: number;
};

export async function loadCompetence(companyId: string, competence: string) {
  const query = new URLSearchParams({ companyId, competence });
  return requestJson<{
    cycle: Row | null;
    batch: LedgerBatch | null;
    summary: LedgerCompetenceSummary;
  }>(`/api/payroll-ledger/batches?${query}`);
}

export async function openBatch(companyId: string, competence: string) {
  return requestJson<{ batch: LedgerBatch }>("/api/payroll-ledger/batches", {
    method: "POST",
    body: JSON.stringify({ companyId, competence }),
  });
}

export async function moveBatch(id: string, status: string, reason = "") {
  return requestJson<{ batch: LedgerBatch; projectedToContractorPayment?: number }>(
    `/api/payroll-ledger/batches/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ status, reason }) },
  );
}

/**
 * Baixa a planilha da competência.
 *
 * O download é feito por `fetch` e não por um link direto porque a resposta
 * carrega o número de linhas em um cabeçalho — e a tela precisa dizer quantas
 * foram, em vez de a pessoa descobrir abrindo o arquivo.
 */
export async function downloadBatchExport(id: string): Promise<{ rows: number; filename: string }> {
  const response = await fetch(`/api/payroll-ledger/batches/${encodeURIComponent(id)}/export`, { cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(payload.error || payload.message || "Não foi possível exportar a competência.");
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "descontos.xlsx";
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return { rows: Number(response.headers.get("X-Fila-Dp-Rows") ?? 0), filename };
}

export type LedgerReturnResult = {
  confirmed: number;
  totalConfirmedInBatch?: number;
  totalAmountInBatch?: number;
  blank: number;
  problems: { sheetRow: number; reason: string }[];
  message?: string;
};

export async function importBatchReturn(id: string, file: File, reference: string): Promise<LedgerReturnResult> {
  const form = new FormData();
  form.set("file", file);
  if (reference) form.set("reference", reference);
  const response = await fetch(`/api/payroll-ledger/batches/${encodeURIComponent(id)}/return`, {
    method: "POST",
    body: form,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as LedgerReturnResult & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível ler o arquivo de retorno.");
  return payload;
}

/* ==========================================================================
 * Importação assistida da planilha.
 * ========================================================================== */

export type LedgerImportCandidate = {
  category: string;
  modality: string;
  totalAmount: number | null;
  installmentCount: number | null;
  currentInstallment: number | null;
  installmentAmount: number | null;
  firstCompetence: string;
  title: string;
  sourceText: string;
  ambiguities: { code: string; message: string }[];
};

export type LedgerImportRow = {
  id: string;
  sheet_name: string;
  row_number: number;
  block_label: string;
  resolution: "pending" | "resolved" | "ignored";
  employee_id: string | null;
  employee_name: string | null;
  entry_id: string | null;
  raw_json: Record<string, string>;
  parsed_json: {
    employeeName?: string;
    unit?: string;
    department?: string;
    operation?: string;
    blockTaxId?: string;
    advanceAmount?: number | null;
    candidates?: LedgerImportCandidate[];
    chosen?: LedgerImportCandidate;
  };
  ambiguities_json: { code: string; message: string }[];
};

export type LedgerImportTotals = {
  total: number;
  resolved: number;
  ignored: number;
  committed: number;
  unidentified: number;
};

export type LedgerImport = {
  id: string;
  filename: string;
  entry_competence: string;
  status: "draft" | "mapped" | "previewed" | "committed" | "canceled";
  totals_json: Record<string, number>;
  mapping_json: { companyId?: string; sheetNames?: string[] };
};

/**
 * Passo 1 — ler o arquivo e listar as abas, sem escolher nenhuma.
 *
 * Sem `sheetNames` nada é gravado: a resposta é só a lista de abas, para a
 * pessoa decidir o que entra. A planilha real tem 87 abas cobrindo sete anos, e
 * importá-la inteira recriaria sete anos de pagamentos já feitos.
 */
export async function listImportSheets(file: File): Promise<{ sheets: string[] }> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/payroll-ledger/imports", { method: "POST", body: form, cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as { sheets?: string[]; error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível ler a planilha.");
  return { sheets: payload.sheets ?? [] };
}

/** Passo 2 — a prévia das abas escolhidas. Grava a interpretação, nenhum lançamento. */
export async function previewImport(input: {
  file: File; companyId: string; entryCompetence: string; sheetNames: string[];
}): Promise<{ importId: string; totals: Record<string, number> }> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("companyId", input.companyId);
  form.set("entryCompetence", input.entryCompetence);
  for (const name of input.sheetNames) form.append("sheetNames", name);
  const response = await fetch("/api/payroll-ledger/imports", { method: "POST", body: form, cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as {
    importId?: string; totals?: Record<string, number>; error?: string; message?: string;
  };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível montar a prévia.");
  return { importId: String(payload.importId ?? ""), totals: payload.totals ?? {} };
}

export async function loadImport(id: string, resolution = ""): Promise<{
  import: LedgerImport; rows: LedgerImportRow[]; totals: LedgerImportTotals;
}> {
  const query = resolution ? `?resolution=${encodeURIComponent(resolution)}` : "";
  return await requestJson(`/api/payroll-ledger/imports/${encodeURIComponent(id)}${query}`);
}

/** Passo 3 — dizer quem é a pessoa e qual proposta vale. Ainda não grava lançamento. */
export async function resolveImportRow(id: string, input: {
  rowId: string; employeeId: string; candidate: LedgerImportCandidate;
}) {
  return await requestJson(`/api/payroll-ledger/imports/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function ignoreImportRow(id: string, rowId: string) {
  return await requestJson(`/api/payroll-ledger/imports/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ rowId, resolution: "ignored" }),
  });
}

export async function cancelImport(id: string) {
  return await requestJson(`/api/payroll-ledger/imports/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ cancel: true }),
  });
}

export type LedgerImportCommitResult = {
  committed: number;
  attempted: number;
  priorInstallmentsAsHistory: number;
  alreadyImported: number;
};

/** Passo 4 — gravar. Tudo ou nada: uma linha resolvida incompleta recusa o lote. */
export async function commitImport(id: string): Promise<LedgerImportCommitResult> {
  const response = await fetch(`/api/payroll-ledger/imports/${encodeURIComponent(id)}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as LedgerImportCommitResult & {
    error?: string; message?: string; problems?: { sheetName: string; rowNumber: number; reason: string }[];
  };
  if (!response.ok) {
    const detalhe = payload.problems?.length
      ? ` ${payload.problems.slice(0, 5).map((p) => `${p.sheetName} linha ${p.rowNumber}: ${p.reason}`).join("; ")}`
      : "";
    throw new Error(`${payload.error || payload.message || "Não foi possível gravar a importação."}${detalhe}`);
  }
  return {
    committed: Number(payload.committed ?? 0),
    attempted: Number(payload.attempted ?? 0),
    priorInstallmentsAsHistory: Number(payload.priorInstallmentsAsHistory ?? 0),
    alreadyImported: Number(payload.alreadyImported ?? 0),
  };
}
