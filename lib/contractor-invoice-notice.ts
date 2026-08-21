/**
 * As mensagens de aviso de nota fiscal, em texto puro.
 *
 * Quem opera o pagamento PJ avisa cada prestador, um por um, do valor que ele
 * precisa emitir. Até aqui isso era feito consultando a tela e escrevendo a
 * mensagem à mão trinta vezes — com o erro previsível de trocar o valor de um
 * pelo do outro, que só aparece quando a nota chega errada.
 *
 * A mensagem carrega **tudo que quem recebe precisa para emitir sem perguntar
 * nada de volta**: o valor, o CNPJ e a razão social de quem recebe a nota, a
 * cidade da prestação e a descrição a preencher. Cada um desses campos que
 * faltasse viraria uma pergunta no privado, e trinta prestadores perguntando a
 * mesma coisa é o trabalho que este arquivo existe para não ter.
 *
 * A empresa é escolhida uma vez e vale para o arquivo inteiro: é a emitente,
 * quem recebe a nota de todo mundo. Ela não recorta a lista — o prestador é do
 * grupo, e recortar deixaria de fora justamente quem atende mais de uma
 * empresa.
 *
 * O nome do prestador abre a saudação, e não uma linha de cabeçalho fora da
 * mensagem: assim o bloco inteiro é copiado sem pensar, e quem cola não corre o
 * risco de mandar para uma pessoa a mensagem de outra — que é o erro que este
 * arquivo mais tem chance de causar, já que as mensagens são quase idênticas.
 *
 * O separador entre blocos é uma linha em branco dupla: as mensagens agora têm
 * parágrafos, e um separador do mesmo tamanho da quebra interna deixaria de
 * separar.
 */

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);

/** "JULHO" — o mês por extenso e em caixa alta, como no texto que se usa. */
function monthName(competence: string) {
  const [year, month] = competence.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) return "";
  return new Intl.DateTimeFormat("pt-BR", { month: "long" })
    .format(new Date(year, month - 1, 1))
    .toLocaleUpperCase("pt-BR");
}

/** 26.016.500/0001-05 a partir dos dígitos; devolve o original quando não é CNPJ. */
function formatTaxId(value: string) {
  const digits = value.replace(/\D/gu, "");
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/u, "$1.$2.$3/$4-$5");
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/u, "$1.$2.$3-$4");
  return value;
}

export type InvoiceNoticeRow = {
  prestador: string;
  nf_esperada: number | string;
};

/** A emitente: quem recebe a nota, com o que precisa aparecer nela. */
export type InvoiceNoticeIssuer = {
  /** Razão social — é ela que vai na nota, não o nome fantasia. */
  razaoSocial: string;
  cnpj: string;
  /** Cidade da prestação do serviço. Vazia, a frase dela não sai. */
  cidade: string;
};

const emitenteVazia: InvoiceNoticeIssuer = { razaoSocial: "", cnpj: "", cidade: "" };

/**
 * A mensagem de um prestador.
 *
 * Cada linha só entra quando tem o que dizer. Uma frase mandando conferir a
 * cidade sem dizer qual, ou um "CNPJ:" seguido de nada, é pior que a ausência:
 * quem recebe entende que o dado existe e que alguém errou ao mandar.
 */
export function invoiceNoticeMessage(input: {
  prestador: string;
  amount: number;
  competence: string;
  emitente?: InvoiceNoticeIssuer;
}) {
  const { razaoSocial, cnpj, cidade } = input.emitente ?? emitenteVazia;
  const mes = monthName(input.competence);
  const ano = input.competence.split("-")[0] ?? "";
  const nome = input.prestador.trim();

  const linhas: string[] = [
    nome ? `Bom dia, ${nome}, tudo bem?` : "Bom dia, tudo bem?",
    "",
    mes
      ? `Sua Nota Fiscal referente ao mês de ${mes} deve ser gerada no valor de ${money(input.amount)}.`
      : `Sua Nota Fiscal deve ser gerada no valor de ${money(input.amount)}.`,
  ];

  const dados = [
    cnpj ? `CNPJ: ${formatTaxId(cnpj)}` : "",
    razaoSocial ? `Razão Social: ${razaoSocial}` : "",
  ].filter(Boolean);
  if (dados.length) linhas.push("Dados para emissão:", "", ...dados);

  linhas.push("");
  if (cidade) linhas.push(`Ficar atento ao preencher a cidade de prestação do serviço: ${cidade}.`);
  if (mes) linhas.push(`Colocar na descrição: "Serviço prestado referente ao mês de ${mes}/${ano}".`);
  linhas.push("Por gentileza emitir sua NF e enviar, fico no aguardo.");

  return linhas.join("\r\n");
}

/**
 * O arquivo inteiro.
 *
 * Devolve texto vazio quando não há ninguém a avisar — a rota transforma isso
 * numa recusa com motivo, em vez de entregar um arquivo em branco que parece
 * defeito.
 */
export function buildInvoiceNoticeFile(
  rows: ReadonlyArray<Record<string, unknown>>,
  emitente?: InvoiceNoticeIssuer,
  competence = "",
) {
  const mensagens = rows
    .map((row) => ({ prestador: String(row.prestador ?? ""), amount: Number(row.nf_esperada ?? 0) || 0 }))
    .filter((row) => row.amount > 0)
    .map((row) => invoiceNoticeMessage({ ...row, competence, emitente }));
  /* Quebra de linha do Windows: o arquivo é aberto no Bloco de Notas na maioria
     das vezes, e com "\n" sozinho ele mostra tudo numa linha só. */
  return mensagens.join("\r\n\r\n\r\n");
}
