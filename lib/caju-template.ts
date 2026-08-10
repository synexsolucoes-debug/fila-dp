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

  // A coluna de crédito é a que fala em valor. Modelos por categoria trocam o
  // final do rótulo ("... em Auxilio Alimentacao", "... em Saldo Livre"), então
  // a busca é pelo começo, não pelo nome inteiro.
  const amountIndex = headers.findIndex((header) => /\bvalor\b/u.test(fold(header)));
  if (amountIndex < 0) {
    throw ApiError.badRequest("O modelo não tem coluna de valor. Confira se baixou a planilha da categoria certa.", "CAJU_TEMPLATE_NO_AMOUNT");
  }

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
  if (folded.includes("saldo livre")) return { key: "saldo_livre", label: "Saldo Livre" };
  if (folded.includes("alimentacao")) return { key: "alimentacao", label: "Auxílio Alimentação" };
  if (folded.includes("refeicao")) return { key: "refeicao", label: "Auxílio Refeição" };
  if (folded.includes("mobilidade")) return { key: "mobilidade", label: "Mobilidade" };
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
