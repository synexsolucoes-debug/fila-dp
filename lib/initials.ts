/**
 * Iniciais para avatar: primeira e última palavra que começam com letra.
 *
 * Feito por grafema, não por posição de string. `"🧑‍💼 Bruno"[0]` é metade de
 * um par substituto e aparecia no avatar como "�B"; e "Ana de Souza" virava
 * "AD" quando a regra pegava as duas primeiras palavras. Palavra que não começa
 * com letra (emoji, número, travessão) não entra na conta.
 */
export function initialsOf(value: string, fallback = "?"): string {
  const segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("pt-BR", { granularity: "grapheme" })
    : null;
  const firstGrapheme = (word: string) => {
    if (!segmenter) return Array.from(word)[0] ?? "";
    return segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? "";
  };
  const letters = String(value ?? "")
    .trim()
    .split(/\s+/u)
    .map(firstGrapheme)
    .filter((grapheme) => /^\p{L}/u.test(grapheme));
  if (letters.length === 0) return fallback;
  const pair = letters.length === 1 ? letters[0] : `${letters[0]}${letters[letters.length - 1]}`;
  return pair.toLocaleUpperCase("pt-BR");
}
