/**
 * Arquivo de pagamento de salários no layout CNAB 240 da FEBRABAN (§4.35 da
 * arquitetura): header de arquivo, header de lote do serviço 30 (pagamento de
 * salários), um segmento A por favorecido com crédito em conta, trailer de
 * lote e trailer de arquivo. Toda linha tem exatamente 240 posições.
 *
 * Cada banco publica a própria variação do layout (convênio, posições
 * reservadas). Este é o padrão FEBRABAN; o banco valida na homologação do
 * convênio. O segmento B (endereço e CPF do favorecido) fica de fora: o
 * Vinculato não guarda o CPF inteiro, e o crédito em conta corrente do mesmo
 * titular não depende dele na maior parte dos bancos.
 */

export type CnabCompany = {
  taxId: string;
  name: string;
  bank: { code: string; agency: string; agencyDigit: string; account: string; accountDigit: string; agreement: string };
};

export type CnabPayment = {
  name: string;
  bankCode: string;
  agency: string;
  agencyDigit: string;
  account: string;
  accountDigit: string;
  amountCents: number;
  /** Seu número: a referência que volta no arquivo de retorno. */
  reference: string;
};

const digits = (value: string) => value.replace(/\D/gu, "");
const strip = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/gu, "").replace(/[^A-Za-z0-9 .,/-]/gu, " ").toUpperCase();
const num = (value: string | number, size: number) => {
  const text = digits(String(value));
  if (text.length > size) throw Object.assign(new Error(`Campo numérico maior que ${size} posições.`), { code: "CNAB_FIELD_TOO_LONG" });
  return text.padStart(size, "0");
};
const alpha = (value: string, size: number) => strip(value).slice(0, size).padEnd(size, " ");
const blank = (size: number) => " ".repeat(size);
const ddmmyyyy = (date: string) => { const [y, m, d] = date.split("-"); return `${d}${m}${y}`; };

function assertLine(line: string, kind: string) {
  if (line.length !== 240) throw new Error(`Registro ${kind} com ${line.length} posições em vez de 240.`);
  return line;
}

export function cnab240Salaries(input: {
  company: CnabCompany; payments: readonly CnabPayment[]; paymentDate: string; generatedAt: Date; sequence: number;
}) {
  const { company, payments } = input;
  if (!payments.length) throw Object.assign(new Error("Nenhum pagamento com conta bancária."), { code: "CNAB_EMPTY" });
  const bank = company.bank;
  const bankCode = num(bank.code, 3);
  const taxId = num(company.taxId, 14);
  const agreement = alpha(bank.agreement, 20);
  const accountBlock = `${num(bank.agency, 5)}${alpha(bank.agencyDigit, 1)}${num(bank.account, 12)}${alpha(bank.accountDigit, 1)}${blank(1)}`;
  const generated = input.generatedAt.toISOString();
  const genDate = ddmmyyyy(generated.slice(0, 10));
  const genTime = generated.slice(11, 19).replace(/:/gu, "");
  const lines: string[] = [];

  // Header de arquivo (registro 0).
  lines.push(assertLine(
    bankCode + "0000" + "0" + blank(9) + "2" + taxId + agreement + accountBlock + alpha(company.name, 30)
    + alpha("", 30) + blank(10) + "1" + genDate + genTime + num(input.sequence, 6) + "103" + "00000" + blank(20) + blank(20) + blank(29),
    "header de arquivo"));

  // Header de lote (registro 1): serviço 30 = salários, forma 01 = crédito em conta.
  lines.push(assertLine(
    bankCode + "0001" + "1" + "C" + "30" + "01" + "045" + blank(1) + "2" + taxId + agreement + accountBlock
    + alpha(company.name, 30) + alpha("PAGAMENTO DE SALARIOS", 40) + alpha("", 30) + num("", 5) + alpha("", 15) + alpha("", 20)
    + num("", 5) + num("", 3) + alpha("", 2) + blank(8) + blank(10),
    "header de lote"));

  // Segmento A (registro 3), um por favorecido.
  let total = 0;
  payments.forEach((payment, index) => {
    total += payment.amountCents;
    const favoredAccount = `${num(payment.agency, 5)}${alpha(payment.agencyDigit, 1)}${num(payment.account, 12)}${alpha(payment.accountDigit, 1)}${blank(1)}`;
    lines.push(assertLine(
      bankCode + "0001" + "3" + num(index + 1, 5) + "A" + "0" + "00" + "000" + num(payment.bankCode, 3) + favoredAccount
      + alpha(payment.name, 30) + alpha(payment.reference, 20) + ddmmyyyy(input.paymentDate) + "BRL" + num("", 15)
      + num(payment.amountCents, 15) + alpha("", 20) + num("", 8) + num("", 15) + alpha("", 40) + alpha("", 2) + alpha("", 5)
      + alpha("", 2) + blank(3) + "0" + blank(10),
      "segmento A"));
  });

  // Trailer de lote (registro 5): quantidade de registros do lote inclui header e trailer.
  lines.push(assertLine(
    bankCode + "0001" + "5" + blank(9) + num(payments.length + 2, 6) + num(total, 18) + num("", 18) + num("", 6) + blank(165) + blank(10),
    "trailer de lote"));

  // Trailer de arquivo (registro 9).
  lines.push(assertLine(
    bankCode + "9999" + "9" + blank(9) + num(1, 6) + num(lines.length + 1, 6) + num("", 6) + blank(205),
    "trailer de arquivo"));

  return { content: `${lines.join("\r\n")}\r\n`, totalCents: total, count: payments.length };
}
