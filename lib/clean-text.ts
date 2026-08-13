/** Normalização pura e segura para código compartilhado entre cliente e servidor. */
export function cleanText(value: unknown, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
