/**
 * Número com a palavra na forma certa: "1 demanda aberta", "3 demandas abertas".
 *
 * Substitui o "demanda(s) aberta(s)" que estava espalhado pelas telas. O "(s)"
 * é atalho de quem escreve, não de quem lê: obriga a pessoa a montar a frase
 * de cabeça, e numa tela cheia de números cada um desses é um tropeço.
 */
export function contagem(total: number, singular: string, plural: string): string {
  return `${total} ${total === 1 ? singular : plural}`;
}
