import ExcelJS from "exceljs";
import { cajuFeeCents, cajuNetCents, CAJU_FEE_BPS, formatFeePercent } from "./caju-fee.ts";
import { normalizeTaxId } from "./caju-export.ts";

/**
 * Planilha de conferência do complemento Caju: nome, documento e valor líquido.
 *
 * Não é o arquivo de pedidos da Caju (esse segue o modelo oficial do portal).
 * Serve para o DP conferir quanto cada prestador recebe, com ou sem a taxa.
 */
export type CajuNetRow = { name: string; taxId: string; amountCents: number; status: string };

export function formatDocument(value: string) {
  const digits = normalizeTaxId(value);
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/u, "$1.$2.$3-$4");
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/u, "$1.$2.$3/$4-$5");
  return value;
}

export async function buildCajuNetSheet(rows: readonly CajuNetRow[], options: { applyFee: boolean; feeBps?: number }) {
  const feeBps = options.feeBps ?? CAJU_FEE_BPS;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Complemento Caju");
  const columns: Partial<ExcelJS.Column>[] = [
    { header: "Nome", key: "name", width: 40 },
    { header: "Documento", key: "taxId", width: 22 },
    { header: "Situação do fechamento", key: "status", width: 24 },
    { header: "Valor do complemento", key: "amount", width: 22, style: { numFmt: "R$ #,##0.00" } },
  ];
  if (options.applyFee) {
    columns.push(
      { header: `Taxa (${formatFeePercent(feeBps)})`, key: "fee", width: 16, style: { numFmt: "R$ #,##0.00" } },
      { header: "Valor líquido", key: "net", width: 18, style: { numFmt: "R$ #,##0.00" } },
    );
  }
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  let amount = 0; let fee = 0; let net = 0;
  for (const row of rows) {
    const rowFee = options.applyFee ? cajuFeeCents(row.amountCents, feeBps) : 0;
    const rowNet = options.applyFee ? cajuNetCents(row.amountCents, feeBps) : row.amountCents;
    amount += row.amountCents; fee += rowFee; net += rowNet;
    sheet.addRow({
      name: row.name, taxId: formatDocument(row.taxId), status: row.status,
      amount: row.amountCents / 100, fee: rowFee / 100, net: rowNet / 100,
    });
  }
  // Documento como texto: o Excel não pode transformar CPF em número.
  sheet.getColumn("taxId").numFmt = "@";
  const total = sheet.addRow({ name: "TOTAL", amount: amount / 100, fee: fee / 100, net: net / 100 });
  total.font = { bold: true };
  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), totals: { amount, fee, net } };
}
