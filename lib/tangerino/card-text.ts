function normalizedCardLines(cardText: string) {
  return cardText
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

function matchesLabel(line: string, labels: readonly RegExp[]) {
  return labels.some((label) => {
    label.lastIndex = 0;
    return label.test(line);
  });
}

/**
 * Lê o formato textual observado no cartão real do Tangerino: o rótulo ocupa
 * uma linha e o valor, a próxima linha não vazia. Os rótulos continuam sendo
 * comparados por inteiro; assim, um texto parecido em outro campo não vira um
 * status plausível por acidente.
 */
export function readCardTextValue(cardText: string, labels: readonly RegExp[]) {
  const lines = normalizedCardLines(cardText);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!matchesLabel(lines[index]!, labels)) continue;
    const value = lines[index + 1]!;
    if (value.length <= 200) return value;
  }
  return undefined;
}

/** Testa os rótulos linha a linha, porque os padrões são ancorados. */
export function hasCardTextLabel(cardText: string, labels: readonly RegExp[]) {
  return normalizedCardLines(cardText).some((line) => matchesLabel(line, labels));
}
