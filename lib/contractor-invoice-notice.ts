/**
 * As mensagens de aviso de nota fiscal, em texto puro.
 *
 * Quem opera o pagamento PJ avisa cada prestador, um por um, do valor que ele
 * precisa emitir. Até aqui isso era feito consultando a tela e escrevendo a
 * mensagem à mão trinta vezes — com o erro previsível de trocar o valor de um
 * pelo do outro, que só aparece quando a nota chega errada.
 *
 * O arquivo sai sem cabeçalho de identificação e sem saudação de horário, por
 * escolha de quem usa: são só as mensagens, em sequência, prontas para copiar.
 * A ordem é a alfabética da tabela da tela, e é ela que permite acompanhar uma
 * enquanto se cola a outra — sem ela o arquivo seria um monte de mensagens
 * quase iguais sem dono.
 *
 * O separador entre blocos é uma linha em branco: dá para selecionar uma
 * mensagem inteira com um clique triplo ou um arraste curto, sem pegar a
 * vizinha.
 */

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);

export type InvoiceNoticeRow = {
  prestador: string;
  nf_esperada: number | string;
};

/** A mensagem de um prestador. Uma frase, o valor, nada mais. */
export function invoiceNoticeMessage(amount: number) {
  return `Olá, tudo bem? Segue o valor a ser emitido referente a sua NF: ${money(amount)}`;
}

/**
 * O arquivo inteiro.
 *
 * Devolve texto vazio quando não há ninguém a avisar — a rota transforma isso
 * numa recusa com motivo, em vez de entregar um arquivo em branco que parece
 * defeito.
 */
export function buildInvoiceNoticeFile(rows: ReadonlyArray<Record<string, unknown>>) {
  const mensagens = rows
    .map((row) => Number(row.nf_esperada ?? 0) || 0)
    .filter((amount) => amount > 0)
    .map((amount) => invoiceNoticeMessage(amount));
  // Quebra de linha do Windows: o arquivo é aberto no Bloco de Notas na
  // maioria das vezes, e com "\n" sozinho ele mostra tudo numa linha só.
  return mensagens.join("\r\n\r\n");
}
