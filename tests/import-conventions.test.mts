import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Import relativo em `lib/` sempre com extensão.
 *
 * A suíte roda `lib/` direto no Node (`--experimental-strip-types`), e o Node
 * não adivinha extensão: um `from "./x"` passa no typecheck e no build do Next
 * e só quebra quando um teste resolve importar aquele módulo.
 */
const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("imports relativos em lib/ trazem a extensão do arquivo", () => {
  const offenders: string[] = [];
  for (const file of walk(join(root, "lib"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/from\s+"(\.\.?\/[^"]+)"/gu)) {
      if (!/\.(ts|tsx|json|mjs|js|cjs)$/u.test(match[1])) offenders.push(`${relative(root, file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `use o caminho com extensão:\n${offenders.join("\n")}`);
});
