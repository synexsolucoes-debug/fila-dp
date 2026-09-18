/**
 * A planilha da competência: ida e volta.
 *
 * O produto **não** tem integração com nenhum ERP de folha, e não inventa
 * layout de importação de nenhum. O que ele faz é o caminho honesto que o DP já
 * usa hoje: exporta o que precisa ser lançado, alguém lança no sistema de
 * folha, e o **mesmo arquivo** volta com o que foi efetivamente descontado.
 *
 * ## Por que o arquivo volta em vez de alguém redigitar
 *
 * Redigitar 400 confirmações é onde o erro entra. O arquivo de retorno carrega
 * o identificador da parcela na primeira coluna, então a conferência compara
 * linha a linha, sem casar por nome — e nome é exatamente o que não identifica
 * pessoa com segurança numa base com homônimos.
 *
 * ## O que a planilha **não** faz
 *
 * Ela não confirma nada sozinha ao ser exportada, e o retorno não confirma nada
 * que não tenha um valor preenchido na coluna de desconto realizado. Linha em
 * branco é linha que ninguém descontou — e não um desconto de zero.
 */
import ExcelJS from "exceljs";

/** Tamanho máximo de um arquivo de retorno. O mesmo teto da planilha Sankhya. */
export const MAX_RETURN_FILE_BYTES = 10 * 1024 * 1024;

export const LEDGER_SHEET_NAME = "Descontos da competência";

/**
 * As colunas, na ordem em que saem.
 *
 * `id` vem primeiro e é a única coluna que o retorno precisa preservar. As
 * demais existem para a pessoa conferir sem abrir o sistema — e por isso a
 * ordem segue a leitura natural: quem é, de onde, por quê, quanto.
 */
export const LEDGER_EXPORT_COLUMNS = [
  { key: "id", header: "ID da parcela", width: 38 },
  { key: "employeeName", header: "Colaborador", width: 34 },
  { key: "registrationNumber", header: "Matrícula", width: 14 },
  { key: "companyName", header: "Empresa", width: 26 },
  { key: "unitLabel", header: "Unidade", width: 18 },
  { key: "departmentLabel", header: "Departamento", width: 20 },
  { key: "category", header: "Categoria", width: 22 },
  { key: "entryTitle", header: "Lançamento", width: 34 },
  { key: "installment", header: "Parcela", width: 10 },
  { key: "competence", header: "Competência", width: 13 },
  { key: "plannedAmount", header: "Valor previsto", width: 16 },
  { key: "alreadyDiscounted", header: "Já descontado", width: 15 },
  { key: "remainingAmount", header: "Saldo da parcela", width: 17 },
  /* A coluna que volta preenchida. Fica por último e vazia de propósito: quem
     recebe o arquivo sabe onde escrever, e nada aqui parece já confirmado. */
  { key: "discountedNow", header: "Desconto realizado", width: 19 },
  { key: "note", header: "Observação do retorno", width: 30 },
] as const;

export type LedgerExportRow = {
  id: string;
  employeeName: string;
  registrationNumber: string;
  companyName: string;
  unitLabel: string;
  departmentLabel: string;
  category: string;
  entryTitle: string;
  installment: string;
  competence: string;
  plannedAmount: number;
  alreadyDiscounted: number;
  remainingAmount: number;
};

/**
 * Monta a planilha da competência.
 *
 * O cabeçalho carrega a competência e a advertência de que exportar não
 * confirma nada. É a frase que evita a leitura mais cara possível deste
 * arquivo: "saiu na planilha, então foi descontado".
 */
export async function buildLedgerWorkbook(input: {
  competence: string;
  companyName: string;
  rows: readonly LedgerExportRow[];
  generatedAt?: string;
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Vinculato";
  workbook.created = new Date(input.generatedAt ?? Date.now());

  const sheet = workbook.addWorksheet(LEDGER_SHEET_NAME);
  sheet.columns = LEDGER_EXPORT_COLUMNS.map((column) => ({
    key: column.key, header: column.header, width: column.width,
  }));

  sheet.spliceRows(1, 0,
    [`Descontos a lançar — ${input.companyName} — competência ${input.competence}`],
    ["Preencha apenas a coluna \"Desconto realizado\" com o valor efetivamente descontado na folha e devolva este arquivo."],
    ["Exportar não confirma desconto. Linha em branco é linha que ninguém descontou."],
    [],
  );
  sheet.getRow(1).font = { bold: true, size: 13 };
  sheet.getRow(5).font = { bold: true };

  for (const row of input.rows) {
    sheet.addRow({
      ...row,
      plannedAmount: row.plannedAmount,
      alreadyDiscounted: row.alreadyDiscounted,
      remainingAmount: row.remainingAmount,
      discountedNow: null,
      note: "",
    });
  }

  for (const chave of ["plannedAmount", "alreadyDiscounted", "remainingAmount", "discountedNow"]) {
    sheet.getColumn(chave).numFmt = '#,##0.00';
  }
  sheet.views = [{ state: "frozen", ySplit: 5 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as ArrayBuffer;
}

export type LedgerReturnRow = {
  installmentId: string;
  amountCents: number;
  note: string;
  sheetRow: number;
};

export type LedgerReturnParse = {
  rows: LedgerReturnRow[];
  /** Linhas em branco: ninguém descontou. Contadas, não tratadas como zero. */
  blank: number;
  /** Linhas que o arquivo trouxe e o produto não soube ler, com o motivo. */
  problems: { sheetRow: number; reason: string }[];
};

const textOf = (value: ExcelJS.CellValue): string => {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("result" in value) return String(value.result ?? "").trim();
    if ("richText" in value) {
      const rich = (value as { richText?: { text?: string }[] }).richText ?? [];
      return rich.map((part) => part.text ?? "").join("").trim();
    }
  }
  return String(value).trim();
};

/**
 * Converte o que veio na célula de dinheiro.
 *
 * Aceita número (o Excel devolve número quando a pessoa digita 200) e texto
 * brasileiro ("1.234,56"). Recusa o resto, nomeando a linha — porque um valor
 * ilegível virando zero seria um desconto que ninguém fez sendo registrado como
 * desconto de zero, e ninguém notaria.
 */
function amountCentsOf(value: ExcelJS.CellValue): { ok: true; cents: number } | { ok: false; reason: string } {
  if (value == null || value === "") return { ok: false, reason: "vazio" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "valor não numérico" };
    return { ok: true, cents: Math.round(value * 100) };
  }
  const bruto = textOf(value);
  if (!bruto) return { ok: false, reason: "vazio" };
  const normalizado = bruto
    .replace(/R\$/giu, "")
    .replace(/\s/gu, "")
    .replace(/\./gu, "")
    .replace(",", ".");
  const numero = Number(normalizado);
  if (!Number.isFinite(numero)) return { ok: false, reason: `valor ilegível ("${bruto}")` };
  return { ok: true, cents: Math.round(numero * 100) };
}

/**
 * Lê o arquivo de retorno.
 *
 * Nada é gravado aqui: esta função só interpreta. Quem decide o que fazer com
 * as linhas é a rota, sob permissão, e cada confirmação continua passando pelo
 * mesmo caminho de qualquer outra — com chave de idempotência e trigger de
 * saldo. O retorno é uma forma de digitar mais rápido, não um atalho que pula
 * as regras.
 */
export async function parseLedgerReturn(buffer: ArrayBuffer): Promise<LedgerReturnParse> {
  if (buffer.byteLength > MAX_RETURN_FILE_BYTES) {
    throw new Error("O arquivo de retorno deve ter no máximo 10 MB.");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(LEDGER_SHEET_NAME) ?? workbook.worksheets[0];
  if (!sheet) throw new Error("A planilha de retorno não tem nenhuma aba legível.");

  /* O cabeçalho é localizado pelo conteúdo, não por posição fixa: quem abre o
     arquivo no Excel às vezes acrescenta uma linha antes de devolver, e recusar
     por causa disso seria rigor sem propósito. */
  let headerRow = 0;
  let idColumn = 0;
  let amountColumn = 0;
  let noteColumn = 0;
  sheet.eachRow((row, rowNumber) => {
    if (headerRow) return;
    row.eachCell((cell, colNumber) => {
      const texto = textOf(cell.value).toLowerCase();
      if (texto === "id da parcela") { headerRow = rowNumber; idColumn = colNumber; }
      if (texto === "desconto realizado") amountColumn = colNumber;
      if (texto === "observação do retorno") noteColumn = colNumber;
    });
    if (headerRow && !amountColumn) { headerRow = 0; idColumn = 0; }
  });

  if (!headerRow || !idColumn || !amountColumn) {
    throw new Error(
      "Não encontrei as colunas \"ID da parcela\" e \"Desconto realizado\". Use o arquivo exportado pelo próprio Vinculato.",
    );
  }

  const rows: LedgerReturnRow[] = [];
  const problems: { sheetRow: number; reason: string }[] = [];
  let blank = 0;
  const vistos = new Set<string>();

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const installmentId = textOf(row.getCell(idColumn).value);
    if (!installmentId) return;

    const valor = amountCentsOf(row.getCell(amountColumn).value);
    if (!valor.ok) {
      if (valor.reason === "vazio") { blank += 1; return; }
      problems.push({ sheetRow: rowNumber, reason: valor.reason });
      return;
    }
    if (valor.cents === 0) {
      /* Zero digitado é diferente de célula vazia, e nenhum dos dois é
         confirmação: descontar R$ 0,00 não é um fato que mereça registro. */
      blank += 1;
      return;
    }
    if (valor.cents < 0) {
      problems.push({ sheetRow: rowNumber, reason: "valor negativo; um estorno é registrado pela tela, com justificativa" });
      return;
    }
    if (vistos.has(installmentId)) {
      problems.push({ sheetRow: rowNumber, reason: "a mesma parcela aparece duas vezes no arquivo" });
      return;
    }
    vistos.add(installmentId);
    rows.push({
      installmentId,
      amountCents: valor.cents,
      note: noteColumn ? textOf(row.getCell(noteColumn).value).slice(0, 200) : "",
      sheetRow: rowNumber,
    });
  });

  return { rows, blank, problems };
}
