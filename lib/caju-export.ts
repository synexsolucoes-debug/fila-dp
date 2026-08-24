import { ApiError } from "./api-errors.ts";

/**
 * Seleção e conferência da exportação Caju — Saldo Livre.
 *
 * O cálculo em si não mora aqui: `calculateContractorClosing` (lib/payments.ts)
 * já resolve líquido → nota → complemento → Caju, em centavos e na ordem certa.
 * Este módulo decide **o que entra no arquivo** e **o que impede de gerá-lo**.
 *
 * A regra que não pode ser afrouxada: exportação silenciosamente incompleta é
 * pior que exportação recusada. Quem confere o total na tela precisa encontrar
 * exatamente o mesmo total no arquivo.
 */

export type CajuCandidate = {
  closingId: string;
  contractorId: string;
  contractorName: string;
  /** Apenas dígitos. Vazio quando o cadastro não tem CPF. */
  taxId: string;
  companyId: string;
  competenceId: string;
  /** Situação do fechamento PJ daquele prestador na competência. */
  closingStatus: string;
  /** Valor destinado à Caju, em centavos. */
  cajuAmountCents: number;
  complementMethod: string;
};

export type CajuBlockReason =
  | "template_missing"
  | "not_approved"
  | "invalid_tax_id"
  | "duplicated_tax_id";

export type CajuBlockDiagnostic = {
  category: "workflow" | "data" | "configuration";
  title: string;
  detail: string;
  action: string;
};

export type CajuPreview = {
  eligible: CajuCandidate[];
  /** Registros que não podem ir para o arquivo, com o motivo de cada um. */
  blocked: Array<{
    closingId: string;
    contractorId: string;
    contractorName: string;
    closingStatus: string;
    reason: CajuBlockReason;
  }>;
  /** Excluídos por regra de negócio, não por erro: Caju zerada. */
  skippedZero: number;
  totalCents: number;
  canExport: boolean;
};

/** Situações em que o fechamento PJ já pode virar pagamento. */
const EXPORTABLE_STATUSES = new Set(["approved", "invoice_pending", "ready_to_pay", "paid", "closed"]);

/**
 * Traduz um bloqueio técnico em diagnóstico operacional. Em especial,
 * `not_approved` não significa necessariamente valor inconsistente: na maior
 * parte dos casos o cálculo só ainda não percorreu Conferência → Aprovação.
 */
export function describeCajuBlock(reason: CajuBlockReason, closingStatus: string): CajuBlockDiagnostic {
  if (reason === "invalid_tax_id") {
    return {
      category: "data",
      title: "CPF ausente ou inválido",
      detail: "O CPF do prestador não tem 11 dígitos válidos ou está preenchido com uma sequência recusada pela Caju.",
      action: "Corrija o CPF no cadastro do prestador e clique em Reconferir.",
    };
  }
  if (reason === "duplicated_tax_id") {
    return {
      category: "data",
      title: "CPF repetido nesta competência",
      detail: "Outro fechamento da mesma empresa e competência usa o mesmo CPF. A Caju pode duplicar ou recusar o crédito.",
      action: "Confira os cadastros dos prestadores, mantenha o CPF na pessoa correta e clique em Reconferir.",
    };
  }
  if (reason === "template_missing") {
    return {
      category: "configuration",
      title: "Modelo oficial não configurado",
      detail: "A estrutura do arquivo de importação da Caju ainda não foi cadastrada.",
      action: "Cadastre o modelo oficial da Caju e clique em Reconferir.",
    };
  }

  const workflow: Record<string, Omit<CajuBlockDiagnostic, "category">> = {
    open: {
      title: "Aguardando conferência",
      detail: "O cálculo está na etapa Aberto. A exportação não encontrou uma inconsistência de valor; o fluxo de aprovação ainda não foi iniciado.",
      action: "Na tabela Fechamento PJ, avance para Conferência, depois Aprovação e Aprovado.",
    },
    review: {
      title: "Conferência ainda não concluída",
      detail: "O cálculo está em Conferência e ainda não foi enviado para a etapa de aprovação.",
      action: "Na tabela Fechamento PJ, avance para Aprovação e depois Aprovado.",
    },
    approval: {
      title: "Aguardando aprovação",
      detail: "O cálculo já passou pela conferência e aguarda a decisão final. A exportação não identificou outra inconsistência neste registro.",
      action: "Na tabela Fechamento PJ, revise os valores e clique em Aprovado.",
    },
    reopened: {
      title: "Fechamento reaberto para correção",
      detail: "O fechamento foi reaberto e a aprovação anterior deixou de valer para esta exportação.",
      action: "Conclua a correção e avance novamente por Conferência, Aprovação e Aprovado.",
    },
  };
  const current = workflow[closingStatus];
  return {
    category: "workflow",
    title: current?.title ?? "Etapa do cálculo não permite exportar",
    detail: current?.detail ?? `A situação atual do fechamento é “${closingStatus || "não informada"}” e ainda não libera a exportação.`,
    action: current?.action ?? "Abra o fechamento PJ, conclua a conferência e a aprovação e clique em Reconferir.",
  };
}

/** CPF só com dígitos, 11 posições, sem sequência repetida. */
export function normalizeTaxId(value: string) {
  return String(value ?? "").replace(/\D/gu, "");
}

export function isValidTaxId(value: string) {
  const digits = normalizeTaxId(value);
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/u.test(digits)) return false;
  // Dígitos verificadores: um CPF inválido recusado na Caju derruba o lote todo.
  const check = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

/**
 * Monta a prévia da exportação.
 *
 * `templateVersion === null` significa que ainda não há modelo oficial da Caju
 * configurado: nesse caso nada é exportável, porque o produto não inventa
 * layout. O bloqueio é explícito, não um arquivo "parecido".
 */
export function buildCajuPreview(
  candidates: readonly CajuCandidate[],
  templateVersion: number | null,
): CajuPreview {
  const eligible: CajuCandidate[] = [];
  const blocked: CajuPreview["blocked"] = [];
  let skippedZero = 0;

  // CPF repetido na mesma empresa e competência viraria duas linhas para a
  // mesma pessoa: a Caju credita uma e recusa ou duplica a outra.
  const seen = new Map<string, string>();

  for (const candidate of candidates) {
    if (candidate.cajuAmountCents <= 0) { skippedZero += 1; continue; }

    if (!EXPORTABLE_STATUSES.has(candidate.closingStatus)) {
      blocked.push({
        closingId: candidate.closingId, contractorId: candidate.contractorId,
        contractorName: candidate.contractorName, closingStatus: candidate.closingStatus, reason: "not_approved",
      });
      continue;
    }
    if (!isValidTaxId(candidate.taxId)) {
      blocked.push({
        closingId: candidate.closingId, contractorId: candidate.contractorId,
        contractorName: candidate.contractorName, closingStatus: candidate.closingStatus, reason: "invalid_tax_id",
      });
      continue;
    }
    const key = `${candidate.companyId}:${candidate.competenceId}:${normalizeTaxId(candidate.taxId)}`;
    if (seen.has(key)) {
      blocked.push({
        closingId: candidate.closingId, contractorId: candidate.contractorId,
        contractorName: candidate.contractorName, closingStatus: candidate.closingStatus, reason: "duplicated_tax_id",
      });
      continue;
    }
    seen.set(key, candidate.contractorId);
    eligible.push(candidate);
  }

  const totalCents = eligible.reduce((total, candidate) => total + candidate.cajuAmountCents, 0);

  return {
    eligible,
    blocked,
    skippedZero,
    totalCents,
    // Sem modelo oficial não há exportação; com erro pendente, também não.
    canExport: templateVersion !== null && eligible.length > 0 && blocked.length === 0,
  };
}

/** Recusa a exportação explicando o que falta, em vez de gerar arquivo torto. */
export function assertExportable(preview: CajuPreview, templateVersion: number | null) {
  if (templateVersion === null) {
    throw new ApiError(409, "CAJU_TEMPLATE_MISSING",
      "Nenhum modelo oficial da Caju está configurado. Baixe a planilha de importação no portal da Caju e cadastre-a em Integrações › Caju › Modelos de importação antes de exportar.");
  }
  if (preview.blocked.length > 0) {
    const detail = preview.blocked
      .map((item) => `${item.contractorName} (${describeCajuBlock(item.reason, item.closingStatus).title})`)
      .slice(0, 8).join("; ");
    throw new ApiError(409, "CAJU_EXPORT_INVALID",
      `A exportação foi interrompida: ${preview.blocked.length} registro(s) impedem o arquivo. ${detail}. Corrija e tente de novo.`,
      { blocked: preview.blocked });
  }
  if (preview.eligible.length === 0) {
    throw new ApiError(409, "CAJU_EXPORT_EMPTY",
      "Nenhum prestador desta competência tem diferença destinada à Caju. Não há arquivo a gerar.");
  }
}

/**
 * Nome previsível e seguro, sem depender de texto digitado pelo usuário.
 *
 * A extensão acompanha o modelo cadastrado: o arquivo de pedidos da Caju é uma
 * planilha de texto separada por `;`, não um XLSX.
 */
export function cajuFileName(companySlug: string, competence: string, extension = "csv", generatedAt = new Date()) {
  const safe = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/(^-|-$)/gu, "").slice(0, 40) || "empresa";
  const date = generatedAt.toISOString().slice(0, 10);
  const safeExtension = /^[a-z0-9]{2,4}$/u.test(extension) ? extension : "csv";
  return `caju_saldo_livre_${safe(companySlug)}_${safe(competence)}_${date}.${safeExtension}`;
}
