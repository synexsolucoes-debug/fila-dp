/**
 * Qual anexo da demanda é a ficha de registro.
 *
 * Mora sozinho, sem dependência de Node, porque os dois lados precisam da mesma
 * resposta: o servidor, para saber de qual arquivo ler; e a tela, para decidir
 * se mostra a aba da ficha e para onde aponta o botão que abre o PDF.
 *
 * Deixar isso em `lib/admission-sheet.ts` arrastaria `node:crypto` e o cofre
 * inteiro para dentro do pacote do navegador — por uma função que só compara
 * nome de arquivo.
 */

/** O nome que o worker grava em `lib/tangerino/attachments-worker.ts`. */
export const REGISTRATION_FORM_FILENAME = "ficha-cadastral-solides.pdf";

/**
 * Prefere o nome exato; aceita a variação numerada.
 *
 * `uniqueFilenames` renumera arquivos ao resolver colisão dentro do ZIP, então
 * `ficha-cadastral-solides (2).pdf` é a mesma ficha e não pode ficar de fora.
 */
export function chooseRegistrationFormAttachment<T extends { id: string; filename: string; contentType: string }>(
  attachments: readonly T[],
) {
  const pdfs = attachments.filter((attachment) => attachment.contentType === "application/pdf");
  return pdfs.find((attachment) => attachment.filename === REGISTRATION_FORM_FILENAME)
    ?? pdfs.find((attachment) => /ficha[-\s]?cadastral/iu.test(attachment.filename))
    ?? null;
}
