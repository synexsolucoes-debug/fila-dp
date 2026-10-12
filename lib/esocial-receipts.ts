/* Conferência do eSocial — sem dependência nenhuma: a tela importa este
   arquivo direto, e nada aqui pode puxar código de servidor para o navegador. */

/**
 * Planilha de recibos exportada do sistema de folha: `matrícula;evento;data;recibo`,
 * separada por `;`, `,` ou tabulação, com data AAAA-MM-DD ou DD/MM/AAAA.
 * Linha que não forma um evento válido é ignorada — cabeçalho incluído —, e
 * a tela conta quantas não acharam evento correspondente.
 */
export function parseReceiptSheet(text: string) {
  return text.replace(/^\uFEFF/u, "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const [registration = "", event = "", rawDate = "", receipt = ""] = line.split(/[;,\t]/u).map((cell) => cell.trim().replace(/^"|"$/gu, ""));
    const date = /^\d{2}\/\d{2}\/\d{4}$/u.test(rawDate) ? `${rawDate.slice(6)}-${rawDate.slice(3, 5)}-${rawDate.slice(0, 2)}` : rawDate;
    const code = event.toUpperCase().replace(/^S(\d)/u, "S-$1");
    if (!/^S-\d{4}$/u.test(code) || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !receipt) return [];
    return [{ registration, event: code, date, receipt }];
  });
}

