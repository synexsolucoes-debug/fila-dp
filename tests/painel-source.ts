import { readFile } from "node:fs/promises";

/**
 * O código do painel, como um texto só.
 *
 * A Visão geral saiu de `WorkspaceApp.tsx` para `features/overview/`. As
 * conferências que leem o texto do painel continuam valendo — só o lugar onde
 * o código mora mudou —, então leem os arquivos juntos, na ordem em que o
 * painel os compõe. Arquivo que sair do `WorkspaceApp` entra nesta lista.
 */
export const painelFiles = [
  "app/painel/WorkspaceApp.tsx",
  "app/painel/features/overview/OverviewView.tsx",
  "app/painel/features/overview/formatting.ts",
] as const;

export async function painelSource(): Promise<string> {
  const parts = await Promise.all(painelFiles.map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
  return parts.join("\n").replaceAll("\r\n", "\n");
}
