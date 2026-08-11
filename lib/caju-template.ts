import { ApiError } from "./api-errors.ts";
import { normalizeTaxId } from "./caju-export.ts";

/**
 * Leitura do modelo oficial de pedidos da Caju e escrita do arquivo de importação.
 *
 * O modelo é uma planilha de texto separada por `;` — não um XLSX. Isso importa:
 * significa que o produto não precisa de biblioteca de planilha para gerar o
 * arquivo, e que os cabeçalhos vêm **do arquivo que o administrador subiu**, não
 * de nomes escritos aqui. A Caju publica um modelo por categoria de benefício e
 * muda os rótulos sem aviso; qualquer nome fixo no código viraria arquivo
 * recusado na importação.
 *
 * O que este módulo garante: mesma ordem de colunas, mesmo delimitador, CPF em
 * dígitos com zeros à esquerda preservados e valor decimal com duas casas.
 */

export type CajuTemplateShape = {
  /** Cabeçalhos exatamente como estão no arquivo oficial, na ordem original. */
  headers: string[];
  delimiter: string;
  /** Índice da coluna de CPF. */
  taxIdIndex: number;
  /** Índice da coluna que recebe o valor a creditar. */
  amountIndex: number;
  /** Rótulo da coluna de valor — identifica a categoria do modelo. */
  amountLabel: string;
  /** Colunas sem mapeamento: saem vazias, como no exemplo oficial. */
  emptyIndexes: number[];
};

const SUPPORTED_DELIMITERS = [";", ",", "\t"] as const;

/** Remove acento e caixa para comparar rótulo sem depender de grafia. */
function fold(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase().trim();
}

/**
 * Palavras que a Caju usa para a coluna de crédito.
 *
 * A lista existe porque os dois modelos oficiais em mãos não se parecem: o de
 * Auxílio Alimentação chama a coluna de "Valor Fixo em Auxilio Alimentacao" e o
 * de Premiação chama simplesmente de "Saldo". Assumir que o rótulo sempre diz
 * "valor" fazia o produto recusar um arquivo oficial legítimo.
 */
const AMOUNT_WORDS = ["valor", "saldo", "credito", "premiacao"];

/** Célula que representa dinheiro no exemplo oficial: número puro, sem símbolo. */
function isNumericCell(cell: string) {
  return /^\d+(?:[.,]\d{1,2})?$/u.test(cell.trim());
}

/**
 * Descobre qual coluna recebe o valor a creditar.
 *
 * Usa dois sinais independentes e exige que não se contradigam:
 *
 *   1. o rótulo da coluna, contra o vocabulário acima;
 *   2. a linha de exemplo que a Caju inclui no modelo — a coluna que traz um
 *      número e não é o CPF.
 *
 * Quando os dois discordam, ou quando nenhum resolve sozinho, a função recusa
 * dizendo quais colunas encontrou. Escolher a coluna errada aqui credita
 * dinheiro no campo errado, e isso não pode ser resolvido por palpite.
 */
function findAmountIndex(headers: string[], content: string, delimiter: string, taxIdIndex: number): number {
  const byLabel = headers
    .map((header, index) => ({ index, folded: fold(header) }))
    .filter(({ index, folded }) => index !== taxIdIndex && AMOUNT_WORDS.some((word) => folded.includes(word)))
    .map(({ index }) => index);

  const sampleLine = content.split("\n")[1] ?? "";
  const sampleCells = sampleLine ? sampleLine.split(delimiter) : [];
  const bySample = sampleCells.length === headers.length
    ? sampleCells
      .map((cell, index) => ({ index, cell }))
      .filter(({ index, cell }) => index !== taxIdIndex && isNumericCell(cell))
      .map(({ index }) => index)
    : [];

  const describe = () => headers.map((header, index) => (index === taxIdIndex ? `${header} (CPF)` : header)).join(", ");

  if (byLabel.length === 1 && bySample.length === 1 && byLabel[0] !== bySample[0]) {
    throw ApiError.badRequest(
      `O modelo é ambíguo: o cabeçalho aponta "${headers[byLabel[0]]}" como coluna de crédito, mas o exemplo preenche "${headers[bySample[0]]}". Envie o arquivo de pedidos exatamente como baixado do portal da Caju.`,
      "CAJU_TEMPLATE_AMBIGUOUS",
    );
  }
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length === 0 && bySample.length === 1) return bySample[0];
  if (byLabel.length > 1) {
    throw ApiError.badRequest(
      `O modelo tem mais de uma coluna que parece de crédito (${byLabel.map((index) => headers[index]).join(", ")}). Envie o arquivo de pedidos de uma categoria só.`,
      "CAJU_TEMPLATE_AMBIGUOUS",
    );
  }
  throw ApiError.badRequest(
    `Não foi possível identificar a coluna de crédito neste modelo. Colunas encontradas: ${describe()}. Confira se baixou a planilha de pedidos da categoria certa.`,
    "CAJU_TEMPLATE_NO_AMOUNT",
  );
}

/**
 * Interpreta o modelo oficial.
 *
 * Aceita apenas a primeira linha como cabeçalho; as linhas de exemplo que a
 * Caju inclui são ignoradas de propósito — elas trazem CPF fictício, e copiá-las
 * para o arquivo real seria criar um pedido inexistente.
 */
export function parseCajuTemplate(content: string): CajuTemplateShape {
  const clean = content.replace(/^﻿/u, "").replace(/\r\n/gu, "\n").trim();
  if (!clean) throw ApiError.badRequest("O modelo enviado está vazio.", "CAJU_TEMPLATE_EMPTY");

  const firstLine = clean.split("\n")[0];
  const delimiter = SUPPORTED_DELIMITERS
    .map((candidate) => ({ candidate, count: firstLine.split(candidate).length }))
    .sort((left, right) => right.count - left.count)[0];
  if (!delimiter || delimiter.count < 2) {
    throw ApiError.badRequest(
      "Não foi possível identificar as colunas do modelo. Envie o arquivo de pedidos exatamente como baixado do portal da Caju.",
      "CAJU_TEMPLATE_INVALID",
    );
  }

  const headers = firstLine.split(delimiter.candidate).map((header) => header.trim());
  if (headers.some((header) => header === "")) {
    throw ApiError.badRequest("O modelo tem coluna sem nome. Envie o arquivo original, sem editar.", "CAJU_TEMPLATE_INVALID");
  }

  const taxIdIndex = headers.findIndex((header) => /\bcpf\b/u.test(fold(header)));
  if (taxIdIndex < 0) {
    throw ApiError.badRequest("O modelo não tem coluna de CPF. Confira se baixou a planilha de pedidos.", "CAJU_TEMPLATE_NO_TAX_ID");
  }

  const amountIndex = findAmountIndex(headers, clean, delimiter.candidate, taxIdIndex);
  const emptyIndexes = headers.map((_, index) => index).filter((index) => index !== taxIdIndex && index !== amountIndex);

  return {
    headers,
    delimiter: delimiter.candidate,
    taxIdIndex,
    amountIndex,
    amountLabel: headers[amountIndex],
    emptyIndexes,
  };
}

/**
 * Categoria declarada pelo modelo, deduzida do rótulo da coluna de valor.
 *
 * Serve para a tela avisar quando o modelo cadastrado é de outra categoria —
 * exportar Saldo Livre usando o modelo de Auxílio Alimentação credita o
 * benefício errado, e a Caju não tem como adivinhar a intenção.
 */
export function templateCategory(shape: CajuTemplateShape): { key: string; label: string } {
  const folded = fold(shape.amountLabel);
  // Categorias com rótulo próprio vêm antes: o modelo de Alimentação também
  // seria "saldo" se a checagem genérica viesse primeiro.
  if (folded.includes("alimentacao")) return { key: "alimentacao", label: "Auxílio Alimentação" };
  if (folded.includes("refeicao")) return { key: "refeicao", label: "Auxílio Refeição" };
  if (folded.includes("mobilidade")) return { key: "mobilidade", label: "Mobilidade" };
  // O modelo de Premiação chama a coluna apenas de "Saldo" — é o Saldo Livre.
  if (folded.includes("saldo") || folded.includes("premiacao")) return { key: "saldo_livre", label: "Saldo Livre" };
  return { key: "desconhecida", label: shape.amountLabel };
}

/** Valor em centavos → decimal com duas casas, sem símbolo e sem separador de milhar. */
export function formatAmount(cents: number) {
  if (!Number.isInteger(cents)) throw ApiError.badRequest("Valor da Caju precisa estar em centavos inteiros.", "CAJU_AMOUNT_INVALID");
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * Escreve o arquivo de importação seguindo o modelo.
 *
 * Nada de coluna extra, aba de auditoria ou observação: o arquivo é para a
 * importação da Caju, e qualquer campo a mais é motivo de recusa. A rastreabilidade
 * fica na trilha de auditoria, não dentro do arquivo.
 */
export function buildCajuFile(
  shape: CajuTemplateShape,
  rows: ReadonlyArray<{ taxId: string; amountCents: number }>,
): string {
  const lines = [shape.headers.join(shape.delimiter)];

  for (const row of rows) {
    const digits = normalizeTaxId(row.taxId);
    if (digits.length !== 11) {
      throw ApiError.badRequest("CPF inválido chegou à escrita do arquivo.", "CAJU_EXPORT_INVALID");
    }
    const cells = shape.headers.map((_, index) => {
      if (index === shape.taxIdIndex) return digits;
      if (index === shape.amountIndex) return formatAmount(row.amountCents);
      return "";
    });
    // O delimitador dentro de célula quebraria o arquivo — nenhuma célula
    // gerada aqui contém texto livre, mas a checagem impede regressão futura.
    if (cells.some((cell) => cell.includes(shape.delimiter) || cell.includes("\n"))) {
      throw ApiError.badRequest("Conteúdo inválido para o arquivo da Caju.", "CAJU_EXPORT_INVALID");
    }
    lines.push(cells.join(shape.delimiter));
  }

  // Quebra de linha final: o exemplo oficial não traz, e arquivos com linha em
  // branco no fim já foram recusados por importadores que leem a última linha.
  return lines.join("\n");
}

/** Nome do arquivo segue a extensão do modelo cadastrado. */
export function cajuFileExtension(shape: CajuTemplateShape) {
  return shape.delimiter === "\t" ? "tsv" : "csv";
}
