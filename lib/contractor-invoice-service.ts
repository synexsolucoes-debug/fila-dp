import type { getD1 } from "../db";
import { ApiError } from "./api-errors.ts";
import type { Capability } from "./authorization.ts";
import { cleanText } from "./clean-text.ts";
import { centsFromDatabase, fromCents } from "./payments.ts";
import {
  assertChecklistComplete,
  compareInvoiceAmount,
  documentDigits,
  findDuplicateInvoice,
  invoiceEventSummary,
  invoicePaymentBlock,
  invoiceRejectionReasonLabels,
  isTerminalInvoiceStatus as rulesIsTerminal,
  reviewStatusFor,
  sanitizeRequiredChecks,
  type DuplicateCandidate,
  type InvoiceChecklistKey,
  type InvoiceEventAction,
  type InvoiceReviewPolicy,
} from "./contractor-invoices.ts";

type Database = ReturnType<typeof getD1>;

/**
 * Persistência do controle de notas fiscais PJ.
 *
 * As regras estão em `contractor-invoices.ts`; aqui só se lê e se grava. A
 * separação não é estética: a regra de "o pagamento pode sair?" precisa valer
 * igual na tela, na API pública e no relatório, e uma regra escrita dentro de
 * um SQL não pode ser reaproveitada por nenhum dos três.
 *
 * Toda consulta deste arquivo carrega `workspace_id` no WHERE, ao lado da RLS
 * do banco. As duas proteções são propositalmente redundantes: a RLS é a que
 * resiste a um erro de programação, o WHERE é o que mantém os índices úteis.
 *
 * ## O ponto de entrada, e por que ele é um só
 *
 * `registerInvoice` é por onde toda nota entra — a tela de Notas Fiscais, a
 * ação "Nota" da tabela de pagamentos, e o que vier depois: portal do
 * prestador, e-mail, leitura de XML, API pública. Nenhum desses canais existe
 * hoje e nenhum foi escrito por antecipação; o que a arquitetura garante é que
 * acrescentá-los não exige uma segunda versão da regra de substituição, da
 * verificação de duplicidade ou do histórico. Um canal novo preenche o mesmo
 * `RegisterInvoiceInput` e ganha tudo isso pronto.
 */

/* -------------------------------------------------------------------------- */
/* Política do grupo                                                           */
/* -------------------------------------------------------------------------- */

export type InvoicePolicy = {
  reviewPolicy: InvoiceReviewPolicy;
  requiredChecks: InvoiceChecklistKey[];
};

/**
 * A política de conferência do grupo.
 *
 * Grupo sem linha de configuração recebe o padrão mais seguro — exigir
 * aprovação —, e não a ausência de regra: um grupo criado antes desta
 * funcionalidade não deveria passar a liberar pagamento sem nota só porque
 * ninguém abriu a tela de configuração ainda.
 */
export async function loadInvoicePolicy(d1: Database, workspaceId: string): Promise<InvoicePolicy> {
  const row = await d1.prepare(`SELECT invoice_review_policy, invoice_required_checks_json
    FROM fdp_workspace_settings WHERE workspace_id = ?`)
    .bind(workspaceId)
    .first<{ invoice_review_policy: string; invoice_required_checks_json: unknown }>();
  return {
    reviewPolicy: row?.invoice_review_policy === "optional" ? "optional" : "required",
    requiredChecks: sanitizeRequiredChecks(parseJson(row?.invoice_required_checks_json)),
  };
}

/** `jsonb` volta como objeto no driver local e como texto em alguns caminhos. */
function parseJson(value: unknown) {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Leitura da competência                                                      */
/* -------------------------------------------------------------------------- */

export type InvoicePanelRow = {
  closingId: string;
  providerId: string;
  providerName: string;
  providerTradeName: string;
  providerDocument: string;
  contractReference: string;
  companyId: string;
  companyName: string;
  companyDocument: string;
  competence: string;
  netAmount: number;
  expectedAmount: number;
  invoiceLimitAmount: number | null;
  closingStatus: string;
  reviewStatus: string;
  invoiceId: string;
  invoiceNumber: string;
  series: string;
  issueDate: string;
  issuerDocument: string;
  issuerName: string;
  informedAmount: number;
  differenceAmount: number;
  invoiceStatus: string;
  documentId: string;
  documentContentType: string;
  documentFilename: string;
  uploadedAt: string;
  uploadedByName: string;
  reviewedAt: string;
  reviewedByUserId: string;
  reviewedByName: string;
  rejectionReason: string;
  attempt: number;
  hasInvoice: boolean;
  paymentBlock: string;
};

/**
 * A lista nasce dos pagamentos da competência, não de um cadastro à parte.
 *
 * Quem precisa emitir nota é quem tem `invoice_expected_amount > 0` no
 * fechamento — o mesmo número que a apuração PJ calculou. Não existe segunda
 * lista para manter em dia, e por isso não existe a divergência clássica entre
 * "os pagamentos do mês" e "as notas do mês".
 *
 * A nota vigente entra por LEFT JOIN: o pagamento sem nota é justamente a linha
 * mais importante da tela, e um INNER JOIN a esconderia.
 */
export async function listInvoicePanel(d1: Database, input: {
  workspaceId: string;
  companyId: string;
  cycleId: string;
  policy: InvoicePolicy;
}) {
  const rows = await d1.prepare(`SELECT
      c.id AS closing_id, c.provider_id, c.company_id, c.competence, c.net_amount, c.invoice_expected_amount,
      c.invoice_limit_amount, c.status AS closing_status, c.invoice_review_status,
      a.legal_name AS provider_name, a.trade_name AS provider_trade_name, a.tax_id AS provider_document,
      coalesce(p.contract_reference, '') AS contract_reference,
      company.trade_name AS company_trade_name, company.legal_name AS company_legal_name, company.tax_id AS company_document,
      i.id AS invoice_id, i.invoice_number, i.series, i.issue_date, i.issuer_document, i.issuer_name,
      i.amount AS informed_amount, i.difference_amount, i.status AS invoice_status, i.attempt,
      i.document_id, i.uploaded_at, i.reviewed_at, i.reviewed_by, i.rejection_reason,
      document.content_type AS document_content_type, document.filename AS document_filename,
      uploader.name AS uploaded_by_name, reviewer.name AS reviewed_by_name
    FROM fdp_contractor_closings c
    JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
    LEFT JOIN fdp_contractor_profiles p ON p.workspace_id = c.workspace_id AND p.provider_id = c.provider_id
    JOIN fdp_companies company ON company.workspace_id = c.workspace_id AND company.id = c.company_id
    LEFT JOIN fdp_contractor_invoices i ON i.workspace_id = c.workspace_id AND i.id = c.invoice_current_id
    LEFT JOIN fdp_contractor_documents document ON document.workspace_id = i.workspace_id AND document.id = i.document_id
    LEFT JOIN fdp_users uploader ON uploader.id = i.uploaded_by
    LEFT JOIN fdp_users reviewer ON reviewer.id = i.reviewed_by
    WHERE c.workspace_id = ? AND c.company_id = ? AND c.payroll_cycle_id = ? AND c.excluded_at IS NULL
    ORDER BY a.legal_name`)
    .bind(input.workspaceId, input.companyId, input.cycleId)
    .all<Record<string, unknown>>();

  return rows.results.map((row) => toPanelRow(row, input.policy));
}

function toPanelRow(row: Record<string, unknown>, policy: InvoicePolicy): InvoicePanelRow {
  const expectedAmount = Number(row.invoice_expected_amount ?? 0);
  const informedAmount = row.informed_amount === null || row.informed_amount === undefined ? 0 : Number(row.informed_amount);
  const reviewStatus = reviewStatusFor({
    expectedAmount,
    invoiceStatus: row.invoice_status === null || row.invoice_status === undefined ? null : String(row.invoice_status),
  });
  const hasInvoice = Boolean(row.invoice_id);
  return {
    closingId: String(row.closing_id ?? ""),
    providerId: String(row.provider_id ?? ""),
    providerName: String(row.provider_name ?? ""),
    providerTradeName: String(row.provider_trade_name ?? ""),
    providerDocument: String(row.provider_document ?? ""),
    contractReference: String(row.contract_reference ?? ""),
    companyId: String(row.company_id ?? ""),
    companyName: String(row.company_trade_name || row.company_legal_name || ""),
    companyDocument: String(row.company_document ?? ""),
    competence: String(row.competence ?? ""),
    netAmount: Number(row.net_amount ?? 0),
    expectedAmount,
    invoiceLimitAmount: row.invoice_limit_amount === null || row.invoice_limit_amount === undefined
      ? null : Number(row.invoice_limit_amount),
    closingStatus: String(row.closing_status ?? ""),
    reviewStatus,
    invoiceId: String(row.invoice_id ?? ""),
    invoiceNumber: String(row.invoice_number ?? ""),
    series: String(row.series ?? ""),
    issueDate: row.issue_date ? String(row.issue_date).slice(0, 10) : "",
    issuerDocument: String(row.issuer_document ?? ""),
    issuerName: String(row.issuer_name ?? ""),
    informedAmount,
    differenceAmount: hasInvoice ? Number(row.difference_amount ?? 0) : 0,
    invoiceStatus: String(row.invoice_status ?? ""),
    documentId: String(row.document_id ?? ""),
    documentContentType: String(row.document_content_type ?? ""),
    documentFilename: String(row.document_filename ?? ""),
    uploadedAt: row.uploaded_at ? String(row.uploaded_at) : "",
    uploadedByName: String(row.uploaded_by_name ?? ""),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : "",
    reviewedByUserId: String(row.reviewed_by ?? ""),
    reviewedByName: String(row.reviewed_by_name ?? ""),
    rejectionReason: String(row.rejection_reason ?? ""),
    attempt: Number(row.attempt ?? 0),
    hasInvoice,
    // A regra de liberação vem do módulo puro, mesmo aqui: a tela, a rota de
    // transição e o relatório precisam responder a mesma coisa.
    paymentBlock: invoicePaymentBlock({ expectedAmount, reviewStatus, policy: policy.reviewPolicy }),
  };
}

/* -------------------------------------------------------------------------- */
/* Uma nota                                                                    */
/* -------------------------------------------------------------------------- */

export type InvoiceRow = {
  id: string; workspace_id: string; company_id: string; provider_id: string; payroll_cycle_id: string;
  closing_id: string; competence: string; attempt: number; invoice_number: string; series: string;
  issue_date: string; issuer_document: string; issuer_name: string; receiver_document: string;
  service_description: string; amount: string | number; expected_amount: string | number;
  difference_amount: string | number; status: string; document_id: string | null;
  checklist_json: unknown; notes: string; duplicate_ack: boolean; uploaded_by: string; uploaded_at: string;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string;
  rejection_reason: string; rejection_detail: string; replaces_invoice_id: string | null;
  replaced_by_invoice_id: string | null; superseded_at: string | null;
};

export async function findInvoice(d1: Database, workspaceId: string, invoiceId: string) {
  const invoice = await d1.prepare("SELECT * FROM fdp_contractor_invoices WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, invoiceId)
    .first<InvoiceRow>();
  if (!invoice) throw ApiError.notFound("Nota fiscal não encontrada.", "CONTRACTOR_INVOICE_NOT_FOUND");
  return invoice;
}

/** Todas as versões da nota de um pagamento, da mais recente para a mais antiga. */
export async function listClosingInvoices(d1: Database, workspaceId: string, closingId: string) {
  const rows = await d1.prepare(`SELECT i.id, i.attempt, i.invoice_number, i.series, i.issue_date, i.amount,
      i.expected_amount, i.difference_amount, i.status, i.document_id, i.rejection_reason, i.rejection_detail,
      i.uploaded_at, i.reviewed_at, i.superseded_at, i.replaces_invoice_id, i.replaced_by_invoice_id,
      document.filename AS document_filename, document.content_type AS document_content_type,
      uploader.name AS uploaded_by_name, reviewer.name AS reviewed_by_name
    FROM fdp_contractor_invoices i
    LEFT JOIN fdp_contractor_documents document ON document.workspace_id = i.workspace_id AND document.id = i.document_id
    LEFT JOIN fdp_users uploader ON uploader.id = i.uploaded_by
    LEFT JOIN fdp_users reviewer ON reviewer.id = i.reviewed_by
    WHERE i.workspace_id = ? AND i.closing_id = ?
    ORDER BY i.attempt DESC`)
    .bind(workspaceId, closingId)
    .all<Record<string, unknown>>();
  return rows.results;
}

/** O histórico da nota, do fato mais recente para o mais antigo. */
export async function listInvoiceEvents(d1: Database, workspaceId: string, closingId: string) {
  const rows = await d1.prepare(`SELECT e.id, e.invoice_id, e.action, e.summary, e.created_at,
      e.before_json, e.after_json, actor.name AS actor_name
    FROM fdp_contractor_invoice_events e
    LEFT JOIN fdp_users actor ON actor.id = e.actor_user_id
    WHERE e.workspace_id = ? AND e.closing_id = ?
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 200`)
    .bind(workspaceId, closingId)
    .all<Record<string, unknown>>();
  return rows.results;
}

/* -------------------------------------------------------------------------- */
/* Escrita                                                                     */
/* -------------------------------------------------------------------------- */

export type InvoiceEventInput = {
  workspaceId: string;
  invoiceId: string;
  closingId: string;
  providerId: string;
  competence: string;
  action: InvoiceEventAction;
  actorUserId: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

/** O evento do histórico, preparado para entrar no mesmo lote da mudança que o originou. */
export function prepareInvoiceEvent(d1: Database, input: InvoiceEventInput) {
  return d1.prepare(`INSERT INTO fdp_contractor_invoice_events
      (id, workspace_id, invoice_id, closing_id, provider_id, competence, action, actor_user_id, summary, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`)
    .bind(crypto.randomUUID(), input.workspaceId, input.invoiceId, input.closingId, input.providerId,
      input.competence, input.action, input.actorUserId, input.summary.slice(0, 500),
      JSON.stringify(input.before ?? {}), JSON.stringify(input.after ?? {}));
}

/**
 * Sincroniza o fechamento com a nota vigente.
 *
 * As colunas de nota do fechamento continuam existindo — a apuração, o extrato
 * analítico e a conciliação as leem. O que muda é a origem: elas passam a ser
 * o reflexo da nota vigente, escrito num lugar só. Enquanto duas telas
 * escreviam as mesmas colunas por caminhos diferentes, era questão de tempo até
 * discordarem.
 */
export function prepareClosingSync(d1: Database, input: {
  workspaceId: string;
  closingId: string;
  invoiceId: string | null;
  invoiceNumber: string;
  amount: number;
  issueDate: string | null;
  documentId: string | null;
  reviewStatus: string;
}) {
  return d1.prepare(`UPDATE fdp_contractor_closings SET
      invoice_current_id = ?, invoice_number = ?, invoice_received_amount = ?, invoice_issue_date = ?,
      invoice_attachment_reference = ?, invoice_review_status = ?, updated_at = now()
    WHERE workspace_id = ? AND id = ?`)
    .bind(input.invoiceId, input.invoiceNumber, input.amount, input.issueDate, input.documentId ?? "",
      input.reviewStatus, input.workspaceId, input.closingId);
}

/**
 * Notas do grupo que podem colidir com a que está entrando.
 *
 * A busca é por número — o campo que a duplicidade sempre repete — e a decisão
 * fina fica com `findDuplicateInvoice`, que compara emissor e série. Filtrar
 * tudo no SQL faria a regra morar em dois lugares.
 */
export async function duplicateCandidates(d1: Database, workspaceId: string, invoiceNumber: string, excludeClosingId: string) {
  const rows = await d1.prepare(`SELECT i.id, i.competence, i.invoice_number, i.series, i.issuer_document,
      i.provider_id, i.status, a.legal_name AS provider_name
    FROM fdp_contractor_invoices i
    JOIN fdp_auxiliary_providers a ON a.workspace_id = i.workspace_id AND a.id = i.provider_id
    WHERE i.workspace_id = ? AND lower(i.invoice_number) = lower(?) AND i.superseded_at IS NULL
      AND i.status NOT IN ('rejected', 'canceled', 'replaced')
      AND (? = '' OR i.closing_id <> ?)
    LIMIT 50`)
    .bind(workspaceId, cleanText(invoiceNumber, 80), excludeClosingId, excludeClosingId)
    .all<DuplicateCandidate & { provider_name: string }>();
  return rows.results.map((row) => ({
    id: String(row.id),
    competence: String(row.competence),
    invoiceNumber: String((row as unknown as Record<string, unknown>).invoice_number ?? ""),
    series: String(row.series ?? ""),
    issuerDocument: String((row as unknown as Record<string, unknown>).issuer_document ?? ""),
    providerId: String((row as unknown as Record<string, unknown>).provider_id ?? ""),
    status: String(row.status),
    providerName: String(row.provider_name ?? ""),
  }));
}

/**
 * Recusa o envio quando já existe nota igual valendo em outro pagamento.
 *
 * Quem tem permissão de conferência pode confirmar e seguir — há casos legítimos
 * de numeração repetida entre emissores diferentes que o sistema não consegue
 * distinguir sozinho. Quem não tem, não passa: o alerta vira recusa.
 */
export async function assertNotDuplicated(d1: Database, input: {
  workspaceId: string;
  closingId: string;
  providerId: string;
  invoiceNumber: string;
  series: string;
  issuerDocument: string;
  acknowledged: boolean;
  canAcknowledge: boolean;
}) {
  const candidates = await duplicateCandidates(d1, input.workspaceId, input.invoiceNumber, input.closingId);
  const duplicate = findDuplicateInvoice(candidates, {
    invoiceNumber: input.invoiceNumber,
    series: input.series,
    issuerDocument: input.issuerDocument,
    providerId: input.providerId,
  });
  if (!duplicate) return null;
  const named = candidates.find((candidate) => candidate.id === duplicate.id);
  const detail = {
    duplicateInvoiceId: duplicate.id,
    competence: duplicate.competence,
    providerName: named?.providerName ?? "",
  };
  if (input.acknowledged && input.canAcknowledge) return detail;
  throw new ApiError(409, "INVOICE_POSSIBLE_DUPLICATE",
    `Possível nota fiscal duplicada: a NF ${input.invoiceNumber} já está registrada em ${duplicate.competence}`
    + `${named?.providerName ? ` para ${named.providerName}` : ""}.`,
    detail);
}

export type RegisterInvoiceInput = {
  workspaceId: string;
  closing: {
    id: string; company_id: string; provider_id: string; payroll_cycle_id: string;
    competence: string; invoice_expected_amount: string | number;
  };
  invoiceNumber: string;
  series: string;
  issueDate: string;
  issuerDocument: string;
  issuerName: string;
  receiverDocument: string;
  serviceDescription: string;
  amount: number;
  notes: string;
  documentId: string | null;
  duplicateAck: boolean;
  replacesInvoiceId: string | null;
  actorUserId: string;
  actorName: string;
  ip: string;
  userAgent: string;
};

/**
 * Registra a nota como um novo envio do pagamento.
 *
 * A anterior não é apagada nem sobrescrita: ela recebe `superseded_at`, muda
 * para `replaced` e passa a apontar para a substituta. Isso é o §15 e o §30 do
 * produto — e a razão pela qual o histórico do pagamento continua explicável
 * depois de três trocas de documento.
 *
 * Tudo entra num lote só: a nota nova, a anterior fechada, o fechamento
 * sincronizado e os dois eventos de histórico. Um envio pela metade deixaria o
 * pagamento apontando para uma nota que não existe.
 */
export async function registerInvoice(d1: Database, input: RegisterInvoiceInput) {
  const expectedAmount = fromCents(centsFromDatabase(input.closing.invoice_expected_amount, "Nota esperada"));
  const comparison = compareInvoiceAmount(expectedAmount, input.amount);

  const current = await d1.prepare(`SELECT id, attempt, invoice_number, status FROM fdp_contractor_invoices
    WHERE workspace_id = ? AND closing_id = ? AND superseded_at IS NULL`)
    .bind(input.workspaceId, input.closing.id)
    .first<{ id: string; attempt: number; invoice_number: string; status: string }>();

  if (input.replacesInvoiceId && current && current.id !== input.replacesInvoiceId) {
    throw new ApiError(409, "INVOICE_REPLACE_CONFLICT",
      "A nota que você está substituindo já não é a vigente deste pagamento. Recarregue e tente novamente.");
  }

  const invoiceId = crypto.randomUUID();
  const attempt = (current?.attempt ?? 0) + 1;
  const statements = [];

  if (current) {
    /* A ordem dos três comandos é obrigatória e foi encontrada rodando o ensaio
       contra um PostgreSQL de verdade:
         1. a anterior sai de cena, liberando o índice que garante uma nota
            vigente por pagamento;
         2. a nova entra;
         3. só então a anterior aponta para a substituta — a chave estrangeira
            é conferida na hora, e apontar antes referenciaria uma linha que
            ainda não existe.
       Tudo no mesmo lote, que é uma transação: um envio pela metade deixaria o
       pagamento apontando para uma nota inexistente. */
    statements.push(d1.prepare(`UPDATE fdp_contractor_invoices
        SET status = CASE WHEN status IN ('approved') THEN status ELSE 'replaced' END,
            superseded_at = now(), updated_at = now()
      WHERE workspace_id = ? AND id = ? AND superseded_at IS NULL`)
      .bind(input.workspaceId, current.id));
    statements.push(prepareInvoiceEvent(d1, {
      workspaceId: input.workspaceId, invoiceId: current.id, closingId: input.closing.id,
      providerId: input.closing.provider_id, competence: input.closing.competence,
      action: "replaced", actorUserId: input.actorUserId,
      summary: invoiceEventSummary({
        action: "replaced", actorName: input.actorName,
        invoiceNumber: current.invoice_number, replacementNumber: input.invoiceNumber,
      }),
      before: { status: current.status, current: true },
      after: { status: "replaced", replacedByInvoiceId: invoiceId },
    }));
  }

  statements.push(d1.prepare(`INSERT INTO fdp_contractor_invoices
      (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence, attempt,
       invoice_number, series, issue_date, issuer_document, issuer_name, receiver_document, service_description,
       amount, expected_amount, difference_amount, status, document_id, notes, duplicate_ack,
       uploaded_by, uploaded_ip, uploaded_user_agent, replaces_invoice_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(invoiceId, input.workspaceId, input.closing.company_id, input.closing.provider_id,
      input.closing.payroll_cycle_id, input.closing.id, input.closing.competence, attempt,
      input.invoiceNumber, input.series, input.issueDate, documentDigits(input.issuerDocument),
      input.issuerName, documentDigits(input.receiverDocument), input.serviceDescription,
      comparison.informedAmount, comparison.expectedAmount, comparison.difference,
      input.documentId, input.notes, input.duplicateAck, input.actorUserId,
      input.ip.slice(0, 60), input.userAgent.slice(0, 200), current?.id ?? null));

  if (current) {
    statements.push(d1.prepare(`UPDATE fdp_contractor_invoices SET replaced_by_invoice_id = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ?`)
      .bind(invoiceId, input.workspaceId, current.id));
  }

  statements.push(prepareInvoiceEvent(d1, {
    workspaceId: input.workspaceId, invoiceId, closingId: input.closing.id,
    providerId: input.closing.provider_id, competence: input.closing.competence,
    action: "uploaded", actorUserId: input.actorUserId,
    summary: invoiceEventSummary({
      action: "uploaded", actorName: input.actorName,
      invoiceNumber: input.invoiceNumber, amount: comparison.informedAmount,
    }),
    after: {
      invoiceNumber: input.invoiceNumber, amount: comparison.informedAmount,
      expectedAmount: comparison.expectedAmount, difference: comparison.difference,
      documentId: input.documentId, attempt,
    },
  }));

  statements.push(prepareClosingSync(d1, {
    workspaceId: input.workspaceId, closingId: input.closing.id, invoiceId,
    invoiceNumber: input.invoiceNumber, amount: comparison.informedAmount,
    issueDate: input.issueDate, documentId: input.documentId,
    reviewStatus: reviewStatusFor({ expectedAmount, invoiceStatus: "received" }),
  }));

  await d1.batch(statements);
  return { invoiceId, attempt, comparison, replacedInvoiceId: current?.id ?? null };
}

/** Reflete no fechamento a decisão tomada sobre a nota vigente. */
export function prepareReviewSync(d1: Database, input: {
  workspaceId: string;
  closingId: string;
  expectedAmount: number;
  invoiceStatus: string;
}) {
  return d1.prepare(`UPDATE fdp_contractor_closings SET invoice_review_status = ?, updated_at = now()
    WHERE workspace_id = ? AND id = ?`)
    .bind(reviewStatusFor({ expectedAmount: input.expectedAmount, invoiceStatus: input.invoiceStatus }),
      input.workspaceId, input.closingId);
}

/* -------------------------------------------------------------------------- */
/* Conferência                                                                 */
/* -------------------------------------------------------------------------- */

export const invoiceReviewActions = ["start_review", "approve", "reject", "request_correction"] as const;
export type InvoiceReviewAction = typeof invoiceReviewActions[number];

/** A permissão exigida por decisão. Aprovar e recusar não são a mesma coisa. */
export const invoiceReviewCapability: Record<InvoiceReviewAction, Capability> = {
  start_review: "invoice.review",
  approve: "invoice.approve",
  reject: "invoice.reject",
  request_correction: "invoice.reject",
};

const invoiceReviewStatus: Record<InvoiceReviewAction, string> = {
  start_review: "under_review",
  approve: "approved",
  reject: "rejected",
  request_correction: "correction_requested",
};

const invoiceReviewEvent: Record<InvoiceReviewAction, InvoiceEventAction> = {
  start_review: "reviewer_assigned",
  approve: "approved",
  reject: "rejected",
  request_correction: "correction_requested",
};

export type ReviewInvoiceInput = {
  workspaceId: string;
  invoice: InvoiceRow;
  closing: { id: string; status: string; invoice_expected_amount: string | number };
  action: InvoiceReviewAction;
  checklist: Record<string, boolean>;
  requiredChecks: readonly string[];
  reviewNote: string;
  rejection: { reason: string; detail: string };
  actorUserId: string;
  actorName: string;
};

/**
 * Aplica a decisão de conferência sobre uma nota.
 *
 * Mora no serviço, e não na rota, porque a mesma decisão acontece por dois
 * caminhos: uma nota na gaveta lateral e várias de uma vez na ação em lote. As
 * regras de "esta nota ainda pode ser decidida?" e "o checklist obrigatório
 * está completo?" precisam ser as mesmas nos dois — aprovar em lote o que não
 * se aprovaria uma a uma é exatamente o risco que uma ação em lote cria.
 *
 * A atualização é condicionada ao estado que foi lido: duas pessoas conferindo
 * a mesma nota ao mesmo tempo resultam em uma decisão registrada e um aviso
 * para a outra, nunca em duas decisões silenciosas.
 */
export async function reviewInvoice(d1: Database, input: ReviewInvoiceInput) {
  const { invoice, action } = input;
  if (invoice.superseded_at || rulesIsTerminal(invoice.status)) {
    throw ApiError.badRequest(
      "Esta nota não é mais a vigente do pagamento. Confira a nota substituta.",
      "INVOICE_NOT_CURRENT",
    );
  }
  if (input.closing.status === "closed" || input.closing.status === "paid") {
    throw ApiError.badRequest(
      "O pagamento está concluído. Reabra com justificativa para rever a nota.",
      "PAYMENT_CLOSING_LOCKED",
    );
  }
  if (action === "approve" && invoice.status === "approved") {
    throw ApiError.badRequest("Esta nota já está aprovada.", "INVOICE_ALREADY_APPROVED");
  }
  if (action === "start_review" && invoice.status !== "received") {
    throw ApiError.badRequest(
      "Só uma nota recém-anexada entra em conferência. As demais já foram decididas.",
      "INVOICE_NOT_REVIEWABLE",
    );
  }
  if (action === "approve") assertChecklistComplete(input.checklist, input.requiredChecks);

  const status = invoiceReviewStatus[action];
  const comparison = compareInvoiceAmount(invoice.expected_amount, invoice.amount);

  const updated = await d1.prepare(`UPDATE fdp_contractor_invoices SET status = ?,
      checklist_json = ?::jsonb, review_note = ?, rejection_reason = ?, rejection_detail = ?,
      reviewed_by = ?, reviewed_at = now(), updated_at = now()
    WHERE workspace_id = ? AND id = ? AND superseded_at IS NULL AND status = ?
    RETURNING id, status`)
    .bind(status, JSON.stringify(input.checklist), input.reviewNote,
      input.rejection.reason, input.rejection.detail, input.actorUserId,
      input.workspaceId, invoice.id, invoice.status)
    .first<{ id: string; status: string }>();
  if (!updated) {
    throw new ApiError(409, "INVOICE_CONFLICT",
      "A nota mudou de estado enquanto você conferia. Recarregue e tente novamente.");
  }

  const reasonLabel = input.rejection.reason
    ? invoiceRejectionReasonLabels[input.rejection.reason as keyof typeof invoiceRejectionReasonLabels] ?? input.rejection.reason
    : "";
  const summary = invoiceEventSummary({
    action: invoiceReviewEvent[action],
    actorName: input.actorName,
    invoiceNumber: invoice.invoice_number,
    amount: action === "approve" ? comparison.informedAmount : undefined,
    reason: input.rejection.detail ? `${reasonLabel} — ${input.rejection.detail}` : reasonLabel,
  });

  await d1.batch([
    prepareInvoiceEvent(d1, {
      workspaceId: input.workspaceId, invoiceId: invoice.id, closingId: invoice.closing_id,
      providerId: invoice.provider_id, competence: invoice.competence,
      action: invoiceReviewEvent[action], actorUserId: input.actorUserId, summary,
      before: { status: invoice.status },
      after: {
        status, checklist: input.checklist, reviewNote: input.reviewNote,
        rejectionReason: input.rejection.reason, rejectionDetail: input.rejection.detail,
        amount: comparison.informedAmount, expectedAmount: comparison.expectedAmount,
        difference: comparison.difference,
      },
    }),
    prepareReviewSync(d1, {
      workspaceId: input.workspaceId, closingId: invoice.closing_id,
      expectedAmount: Number(input.closing.invoice_expected_amount ?? 0),
      invoiceStatus: status,
    }),
  ]);

  return { status, summary, comparison };
}
