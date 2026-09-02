import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";
import { centsFromDatabase, fromCents, toCents } from "./payments.ts";

/**
 * Controle e validação de notas fiscais PJ.
 *
 * Este módulo é puro de propósito, como `payments.ts`: não abre banco, não lê
 * sessão e não toca em rede. As regras que decidem se uma nota confere, se ela
 * pode ser aprovada e se o pagamento pode sair ficam aqui para serem
 * versionadas e testadas isoladamente — e para que a tela, a API e o relatório
 * não tenham cada um a sua interpretação da mesma regra.
 *
 * O que ele **não** faz, também de propósito: calcular o valor esperado da
 * nota. Isso é `calculateContractorClosing`, e continua sendo. Duplicar a
 * conta aqui criaria dois números com o mesmo nome — a maneira mais barata de
 * fazer a tela de notas discordar da tela de pagamentos sem ninguém perceber.
 */

/* -------------------------------------------------------------------------- */
/* Situações                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Situação da nota em si — o registro enviado.
 *
 * `replaced` e `canceled` são estados de fim de vida: a nota saiu de cena mas
 * continua no banco, porque o histórico do pagamento precisa continuar
 * explicável depois que alguém troca o documento.
 */
export const contractorInvoiceStatuses = [
  "received", "under_review", "approved", "rejected", "correction_requested", "replaced", "canceled",
] as const;
export type ContractorInvoiceStatus = typeof contractorInvoiceStatuses[number];

/**
 * Situação da conferência vista do pagamento.
 *
 * Difere da lista acima em dois pontos, e os dois importam: `not_required`
 * (o prestador não emite nota nesta competência) e `awaiting_issue` (emite, e
 * ainda não mandou) não são estados de nenhuma nota — são estados da ausência
 * dela, e é justamente essa ausência que a tela precisa mostrar.
 */
export const invoiceReviewStatuses = [
  "not_required", "awaiting_issue", "received", "under_review", "approved", "rejected", "correction_requested",
] as const;
export type InvoiceReviewStatus = typeof invoiceReviewStatuses[number];

/** O nome de cada situação para quem lê, sem depender de cor para distinguir. */
export const invoiceReviewStatusLabels: Record<InvoiceReviewStatus, string> = {
  not_required: "Não emite nota",
  awaiting_issue: "Aguardando nota",
  received: "Nota anexada",
  under_review: "Aguardando conferência",
  approved: "Aprovada",
  rejected: "Rejeitada",
  correction_requested: "Correção solicitada",
};

export const contractorInvoiceStatusLabels: Record<ContractorInvoiceStatus, string> = {
  received: "Nota anexada",
  under_review: "Aguardando conferência",
  approved: "Aprovada",
  rejected: "Rejeitada",
  correction_requested: "Correção solicitada",
  replaced: "Substituída",
  canceled: "Cancelada",
};

/** Situações em que a nota deixou de ser a vigente do fechamento. */
const terminalInvoiceStatuses = new Set<ContractorInvoiceStatus>(["replaced", "canceled"]);

export function isTerminalInvoiceStatus(status: string) {
  return terminalInvoiceStatuses.has(status as ContractorInvoiceStatus);
}

/**
 * A situação da conferência que o pagamento passa a mostrar.
 *
 * Uma função só, usada pela gravação e pela leitura, para que a coluna do
 * fechamento e o que a tela desenha não possam divergir.
 */
export function reviewStatusFor(input: {
  expectedAmount: number;
  invoiceStatus: string | null;
}): InvoiceReviewStatus {
  if (input.expectedAmount <= 0) return "not_required";
  const status = input.invoiceStatus ?? "";
  if (!status || isTerminalInvoiceStatus(status)) return "awaiting_issue";
  if (status === "received") return "received";
  if (status === "under_review") return "under_review";
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "correction_requested") return "correction_requested";
  return "awaiting_issue";
}

/* -------------------------------------------------------------------------- */
/* Motivos de recusa                                                           */
/* -------------------------------------------------------------------------- */

export const invoiceRejectionReasons = [
  "amount_mismatch", "issuer_document_mismatch", "wrong_competence", "wrong_receiver",
  "canceled_invoice", "unreadable_document", "duplicate_invoice", "data_divergence", "other",
] as const;
export type InvoiceRejectionReason = typeof invoiceRejectionReasons[number];

export const invoiceRejectionReasonLabels: Record<InvoiceRejectionReason, string> = {
  amount_mismatch: "Valor incorreto",
  issuer_document_mismatch: "CNPJ/CPF do emissor incorreto",
  wrong_competence: "Competência incorreta",
  wrong_receiver: "Empresa tomadora incorreta",
  canceled_invoice: "Nota cancelada",
  unreadable_document: "Documento ilegível",
  duplicate_invoice: "Nota duplicada",
  data_divergence: "Dados divergentes",
  other: "Outro",
};

/**
 * Valida a razão da recusa.
 *
 * "Outro" sem descrição devolve a nota ao prestador dizendo apenas que ela está
 * errada — o que garante uma segunda rodada de conversa e nenhuma correção. Por
 * isso a descrição é exigida aqui, e também no banco.
 */
export function validateRejection(reason: unknown, detail: unknown) {
  const chosen = cleanText(reason, 40);
  if (!(invoiceRejectionReasons as readonly string[]).includes(chosen)) {
    throw ApiError.badRequest("Informe o motivo da recusa da nota fiscal.", "INVOICE_REJECTION_REASON_REQUIRED");
  }
  const description = cleanText(detail, 500);
  if (chosen === "other" && description.length < 5) {
    throw ApiError.badRequest("Descreva o motivo da recusa com pelo menos 5 caracteres.", "INVOICE_REJECTION_DETAIL_REQUIRED");
  }
  return { reason: chosen as InvoiceRejectionReason, detail: description };
}

/* -------------------------------------------------------------------------- */
/* Checklist de conferência                                                    */
/* -------------------------------------------------------------------------- */

/**
 * O checklist é de apoio, não de burocracia.
 *
 * Ele existe para que quem confere trinta notas seguidas não esqueça o quarto
 * item na vigésima. Quais itens são *obrigatórios* para aprovar é configuração
 * do grupo (`invoice_required_checks_json`): por padrão nenhum é, e o checklist
 * apenas acompanha a decisão no histórico.
 */
export const invoiceChecklistItems = [
  { key: "issuer_document", label: "CNPJ/CPF do prestador confere" },
  { key: "receiver", label: "Empresa tomadora confere" },
  { key: "competence", label: "Competência confere" },
  { key: "amount", label: "Valor da nota confere" },
  { key: "invoice_number", label: "Número da NF informado" },
  { key: "issue_date", label: "Data de emissão válida" },
  { key: "readable", label: "Documento legível" },
  { key: "not_duplicated", label: "Não existe duplicidade" },
] as const;

export type InvoiceChecklistKey = typeof invoiceChecklistItems[number]["key"];

const checklistKeys = new Set<string>(invoiceChecklistItems.map((item) => item.key));

export function sanitizeChecklist(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const checked: Record<string, boolean> = {};
  for (const key of Object.keys(source)) {
    if (checklistKeys.has(key)) checked[key] = source[key] === true;
  }
  return checked;
}

/** Somente chaves conhecidas viram exigência: uma chave inventada travaria toda aprovação. */
export function sanitizeRequiredChecks(value: unknown): InvoiceChecklistKey[] {
  const list = Array.isArray(value) ? value : [];
  const chosen = list.map((item) => cleanText(item, 40)).filter((item) => checklistKeys.has(item));
  return [...new Set(chosen)] as InvoiceChecklistKey[];
}

/** Recusa a aprovação enquanto faltar um item que o grupo tornou obrigatório. */
export function assertChecklistComplete(checklist: Record<string, boolean>, required: readonly string[]) {
  const missing = required.filter((key) => checklist[key] !== true);
  if (missing.length === 0) return;
  const labels = missing.map((key) => invoiceChecklistItems.find((item) => item.key === key)?.label ?? key);
  throw ApiError.badRequest(
    `A conferência exige confirmar: ${labels.join(", ")}.`,
    "INVOICE_CHECKLIST_INCOMPLETE",
  );
}

/* -------------------------------------------------------------------------- */
/* Comparação de valores                                                       */
/* -------------------------------------------------------------------------- */

export type InvoiceAmountComparison = {
  expectedAmount: number;
  informedAmount: number;
  /** Informado menos esperado: negativo é nota a menor. */
  difference: number;
  matches: boolean;
};

/**
 * Compara o valor esperado com o informado, em centavos.
 *
 * A conta é feita em inteiros porque `6000.00 - 5500.00` em ponto flutuante
 * devolve 499.9999999999995, e uma tela de conferência que mostra "divergência
 * de R$ 499,9999999999995" destrói a confiança em todo o resto do número.
 *
 * `matches` diz que os valores coincidem — não que a nota está aprovada.
 * Aprovação é ato humano, e o §8 do produto é explícito: não aprovar
 * automaticamente só porque os valores são iguais.
 */
export function compareInvoiceAmount(expectedAmount: unknown, informedAmount: unknown): InvoiceAmountComparison {
  const expectedCents = centsFromDatabase(expectedAmount ?? 0, "Valor esperado da nota");
  const informedCents = centsFromDatabase(informedAmount ?? 0, "Valor da nota");
  return {
    expectedAmount: fromCents(expectedCents),
    informedAmount: fromCents(informedCents),
    difference: fromCents(informedCents - expectedCents),
    matches: expectedCents === informedCents,
  };
}

/** O valor da nota digitado por alguém, validado como dinheiro não negativo. */
export function invoiceAmountFromInput(value: unknown) {
  const cents = toCents(value ?? 0, "Valor da nota");
  if (cents <= 0) throw ApiError.badRequest("Informe o valor da nota fiscal.", "INVOICE_AMOUNT_REQUIRED");
  return fromCents(cents);
}

/* -------------------------------------------------------------------------- */
/* Liberação do pagamento                                                      */
/* -------------------------------------------------------------------------- */

export const invoiceReviewPolicies = ["required", "optional"] as const;
export type InvoiceReviewPolicy = typeof invoiceReviewPolicies[number];

/**
 * O pagamento pode sair?
 *
 * Uma pergunta, uma resposta, um lugar. A rota de transição, a tela de
 * pagamentos e a listagem de notas fazem a mesma pergunta em três momentos
 * diferentes, e três cópias da regra é como o financeiro acaba vendo "pronto
 * para pagamento" numa tela e "bloqueado" na outra.
 *
 * Devolve o motivo em português quando bloqueia — a mensagem é o produto aqui:
 * "pagamento bloqueado" sem dizer por quê obriga a abrir chamado.
 */
export function invoicePaymentBlock(input: {
  expectedAmount: number;
  reviewStatus: string;
  policy: InvoiceReviewPolicy;
}): string {
  if (input.expectedAmount <= 0) return "";
  if (input.policy === "optional") return "";
  switch (input.reviewStatus) {
    case "approved": return "";
    case "awaiting_issue": return "A nota fiscal ainda não foi enviada.";
    case "received": return "A nota fiscal foi anexada e ainda não entrou em conferência.";
    case "under_review": return "A nota fiscal está aguardando conferência.";
    case "rejected": return "A nota fiscal foi rejeitada e precisa ser substituída.";
    case "correction_requested": return "Foi solicitada correção da nota fiscal.";
    default: return "A nota fiscal ainda não foi aprovada.";
  }
}

/** Verdadeiro quando o prestador está apto a receber nesta competência. */
export function readyForPayment(input: {
  expectedAmount: number;
  reviewStatus: string;
  policy: InvoiceReviewPolicy;
}) {
  return invoicePaymentBlock(input) === "";
}

/* -------------------------------------------------------------------------- */
/* Arquivo                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Tipos aceitos.
 *
 * PDF e imagem são o que chega hoje; o XML entra porque é a nota em si nos
 * municípios que a emitem assim, e ler o XML é o próximo passo natural do
 * módulo. Nada além disso: um arquivo executável guardado num bucket de notas
 * fiscais é uma porta de entrada, não um anexo.
 */
export const invoiceFileTypes = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/xml": ["xml"],
  "text/xml": ["xml"],
} as const;

export const INVOICE_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** Extensões que o visualizador interno abre sem download. */
const previewableTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export function isPreviewableInvoiceType(contentType: string) {
  return previewableTypes.has(contentType);
}

/**
 * Nome de arquivo seguro para guardar e devolver.
 *
 * Barra, contrabarra, aspas e quebra de linha saem: os três primeiros
 * atravessam caminho de armazenamento, o último quebra o cabeçalho HTTP que
 * carrega o nome. O resultado nunca é vazio — um anexo sem nome é um anexo que
 * ninguém encontra depois.
 */
export function sanitizeInvoiceFilename(value: unknown) {
  const raw = cleanText(value, 220).replace(/[\u0000-\u001F\u007F]/gu, "");
  // Só o nome do arquivo, nunca o caminho: `../../etc/passwd` guarda o nome
  // `passwd`, e a travessia deixa de existir antes de qualquer verificação de
  // extensão. Trocar as barras por sublinhado preservaria os `..` no nome.
  const base = raw.split(/[\\/]/u).at(-1) ?? "";
  const safe = base.replace(/[:*?"<>|]/gu, "_").replace(/^\.+/u, "").trim();
  return safe.slice(0, 200) || "nota-fiscal";
}

export type InvoiceFileCheck = { contentType: string; extension: string };

/**
 * Confere tipo, extensão e tamanho antes de qualquer gravação.
 *
 * A extensão precisa combinar com o tipo declarado: aceitar `nota.pdf.exe`
 * porque o navegador mandou `application/pdf` é confiar no cliente para uma
 * decisão de segurança do servidor.
 */
export function checkInvoiceFile(input: { name: string; type: string; size: number }): InvoiceFileCheck {
  if (input.size <= 0) throw ApiError.badRequest("O arquivo da nota fiscal está vazio.", "INVOICE_FILE_EMPTY");
  if (input.size > INVOICE_FILE_MAX_BYTES) {
    throw new ApiError(413, "INVOICE_FILE_TOO_LARGE", "O arquivo da nota excede o limite de 20 MB.");
  }
  const contentType = cleanText(input.type, 120).toLowerCase();
  const allowed = (invoiceFileTypes as Record<string, readonly string[]>)[contentType];
  const extension = sanitizeInvoiceFilename(input.name).split(".").pop()?.toLowerCase() ?? "";
  if (!allowed || !allowed.includes(extension)) {
    throw new ApiError(415, "INVOICE_FILE_TYPE_NOT_ALLOWED",
      "Use PDF, JPG, PNG, WEBP ou XML para a nota fiscal, com a extensão correspondente ao arquivo.");
  }
  return { contentType, extension };
}

/* -------------------------------------------------------------------------- */
/* Duplicidade                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Uma confirmação marcada.
 *
 * O mesmo campo chega como `true` do JSON e como a string `"true"` do
 * formulário multipart. Comparar com `true` funcionaria em um caminho e
 * falharia silenciosamente no outro — e o caminho que falharia é justamente o
 * do envio com arquivo, onde a confirmação de duplicidade importa.
 */
export function isConfirmed(value: unknown) {
  return value === true || cleanText(value, 10).toLowerCase() === "true";
}

/** Só os dígitos do CNPJ/CPF: a mesma inscrição chega com e sem pontuação. */
export function documentDigits(value: unknown) {
  return cleanText(value, 40).replace(/\D/gu, "").slice(0, 14);
}

export type DuplicateCandidate = {
  id: string;
  competence: string;
  invoiceNumber: string;
  series: string;
  issuerDocument: string;
  providerId: string;
  status: string;
};

/**
 * Uma nota é possivelmente duplicada quando repete emissor, número e série.
 *
 * A conferência é do grupo inteiro, não da competência: reenviar em setembro a
 * nota de agosto é exatamente o erro que esta verificação existe para pegar, e
 * um recorte por competência o deixaria passar.
 *
 * A função não decide o que fazer — quem decide é a rota, com a permissão de
 * quem está enviando. Aqui só se responde "parece duplicada, e com qual".
 */
export function findDuplicateInvoice(
  candidates: readonly DuplicateCandidate[],
  target: { invoiceNumber: string; series: string; issuerDocument: string; providerId: string },
): DuplicateCandidate | null {
  const number = cleanText(target.invoiceNumber, 80).toLowerCase();
  const series = cleanText(target.series, 20).toLowerCase();
  const issuer = documentDigits(target.issuerDocument);
  if (!number) return null;
  return candidates.find((candidate) => {
    if (isTerminalInvoiceStatus(candidate.status) || candidate.status === "rejected") return false;
    if (cleanText(candidate.invoiceNumber, 80).toLowerCase() !== number) return false;
    if (cleanText(candidate.series, 20).toLowerCase() !== series) return false;
    // Sem CNPJ informado dos dois lados, o prestador é a âncora: ele já
    // identifica de quem é a nota, e exigir o documento faria a verificação
    // sumir justamente nas notas com menos dados preenchidos.
    if (issuer && candidate.issuerDocument) return documentDigits(candidate.issuerDocument) === issuer;
    return candidate.providerId === target.providerId;
  }) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Indicadores da competência                                                  */
/* -------------------------------------------------------------------------- */

export type InvoiceCompetenceRow = {
  expectedAmount: number;
  reviewStatus: string;
  informedAmount: number;
  hasInvoice: boolean;
};

export type InvoiceCompetenceSummary = {
  /** Prestadores que precisam emitir nota nesta competência. */
  requiredCount: number;
  receivedCount: number;
  pendingCount: number;
  awaitingReviewCount: number;
  approvedCount: number;
  rejectedCount: number;
  correctionCount: number;
  divergentCount: number;
  readyCount: number;
  expectedAmount: number;
  approvedAmount: number;
  receivedAmount: number;
  /** Percentual de notas aprovadas entre as exigidas; 0 a 100, inteiro. */
  progress: number;
};

/**
 * Os indicadores da competência, calculados sobre as linhas reais.
 *
 * O progresso considera só quem é obrigado a emitir — incluir quem não emite
 * faria o número subir sozinho ao cadastrar um prestador sem nota, que é o
 * oposto de medir andamento.
 */
export function summarizeInvoiceCompetence(
  rows: readonly InvoiceCompetenceRow[],
  policy: InvoiceReviewPolicy = "required",
): InvoiceCompetenceSummary {
  const required = rows.filter((row) => row.expectedAmount > 0);
  const count = (status: string) => required.filter((row) => row.reviewStatus === status).length;
  const approved = required.filter((row) => row.reviewStatus === "approved");
  const received = required.filter((row) => row.hasInvoice);
  const expectedCents = required.reduce((total, row) => total + centsFromDatabase(row.expectedAmount, "Nota esperada"), 0);
  const approvedCents = approved.reduce((total, row) => total + centsFromDatabase(row.informedAmount, "Nota aprovada"), 0);
  const receivedCents = received.reduce((total, row) => total + centsFromDatabase(row.informedAmount, "Nota recebida"), 0);

  return {
    requiredCount: required.length,
    receivedCount: received.length,
    pendingCount: count("awaiting_issue"),
    awaitingReviewCount: count("received") + count("under_review"),
    approvedCount: approved.length,
    rejectedCount: count("rejected"),
    correctionCount: count("correction_requested"),
    divergentCount: received.filter((row) => !compareInvoiceAmount(row.expectedAmount, row.informedAmount).matches).length,
    readyCount: required.filter((row) => readyForPayment({
      expectedAmount: row.expectedAmount, reviewStatus: row.reviewStatus, policy,
    })).length,
    expectedAmount: fromCents(expectedCents),
    approvedAmount: fromCents(approvedCents),
    receivedAmount: fromCents(receivedCents),
    progress: required.length === 0 ? 0 : Math.round((approved.length / required.length) * 100),
  };
}

/* -------------------------------------------------------------------------- */
/* Filtros rápidos                                                             */
/* -------------------------------------------------------------------------- */

export const invoiceQuickFilters = [
  "all", "pending", "missing", "received", "awaiting_review", "approved", "rejected", "divergent", "ready",
] as const;
export type InvoiceQuickFilter = typeof invoiceQuickFilters[number];

export const invoiceQuickFilterLabels: Record<InvoiceQuickFilter, string> = {
  all: "Todas",
  pending: "Pendentes",
  missing: "Sem NF",
  received: "Recebidas",
  awaiting_review: "Aguardando conferência",
  approved: "Aprovadas",
  rejected: "Rejeitadas",
  divergent: "Com divergência de valor",
  ready: "Prontas para pagamento",
};

/**
 * O recorte de cada filtro rápido, como predicado.
 *
 * Fica aqui, e não no componente, porque a exportação precisa aplicar o mesmo
 * recorte: um relatório que traz linhas diferentes das que estão na tela é
 * pior que não ter relatório.
 */
export function matchesQuickFilter(
  row: InvoiceCompetenceRow,
  filter: InvoiceQuickFilter,
  policy: InvoiceReviewPolicy = "required",
): boolean {
  if (filter === "all") return true;
  if (row.expectedAmount <= 0) return false;
  switch (filter) {
    case "pending": return row.reviewStatus !== "approved";
    case "missing": return !row.hasInvoice;
    case "received": return row.hasInvoice;
    case "awaiting_review": return row.reviewStatus === "received" || row.reviewStatus === "under_review";
    case "approved": return row.reviewStatus === "approved";
    case "rejected": return row.reviewStatus === "rejected" || row.reviewStatus === "correction_requested";
    case "divergent": return row.hasInvoice && !compareInvoiceAmount(row.expectedAmount, row.informedAmount).matches;
    case "ready": return readyForPayment({ expectedAmount: row.expectedAmount, reviewStatus: row.reviewStatus, policy });
    default: return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Histórico                                                                   */
/* -------------------------------------------------------------------------- */

export const invoiceEventActions = [
  "uploaded", "submitted", "approved", "rejected", "correction_requested",
  "replaced", "superseded", "reviewer_assigned", "updated", "canceled",
] as const;
export type InvoiceEventAction = typeof invoiceEventActions[number];

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);

/**
 * A frase do histórico.
 *
 * "Nota NF 1425 anexada por João às 10:32" é o que se lê numa auditoria; um
 * par `action: "uploaded"` não é. A frase é montada na gravação e guardada
 * junto do evento, para que ler o histórico não dependa de reconstruir o
 * contexto de cada linha.
 */
export function invoiceEventSummary(input: {
  action: InvoiceEventAction;
  actorName: string;
  invoiceNumber: string;
  amount?: number;
  reason?: string;
  replacementNumber?: string;
}) {
  const who = input.actorName || "um usuário";
  const nota = input.invoiceNumber ? `NF ${input.invoiceNumber}` : "a nota";
  switch (input.action) {
    case "uploaded":
      return `${nota} anexada por ${who}${input.amount === undefined ? "" : `. Valor informado: ${money(input.amount)}`}.`;
    case "submitted":
      return `${nota} enviada para conferência por ${who}.`;
    case "approved":
      return `${nota} aprovada por ${who}${input.amount === undefined ? "" : `. Valor aprovado: ${money(input.amount)}`}.`;
    case "rejected":
      return `${nota} rejeitada por ${who}${input.reason ? `. Motivo: ${input.reason}` : ""}.`;
    case "correction_requested":
      return `Correção de ${nota} solicitada por ${who}${input.reason ? `. Motivo: ${input.reason}` : ""}.`;
    case "replaced":
      return `${nota} substituída${input.replacementNumber ? ` pela NF ${input.replacementNumber}` : ""} por ${who}.`;
    case "superseded":
      return `${nota} deixou de ser a nota vigente do pagamento.`;
    case "reviewer_assigned":
      return `${nota} atribuída para conferência por ${who}.`;
    case "canceled":
      return `${nota} cancelada por ${who}${input.reason ? `. Motivo: ${input.reason}` : ""}.`;
    default:
      return `${nota} atualizada por ${who}.`;
  }
}
