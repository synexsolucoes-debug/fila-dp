import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Componente de navegador nunca alcança o banco.
 *
 * O pacote `server-only` faria essa trava no build, mas ele lança erro em
 * qualquer import fora do servidor do React — e a suíte importa `lib/` direto
 * pelo Node. A prova então segue o grafo de imports a partir de cada arquivo
 * `"use client"` e reprova quando o caminho chega em `db/` ou em `next/headers`
 * (cookie e sessão também são do servidor).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/u.test(name)) out.push(full);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  if (/\.tsx?$/u.test(base)) candidates.unshift(base);
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? null;
}

/** Só imports de valor: `import type` some na compilação e não leva código. */
function valueImports(source: string): string[] {
  const specs: string[] = [];
  const pattern = /^\s*import\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gmu;
  for (const match of source.matchAll(pattern)) specs.push(match[1]);
  for (const match of source.matchAll(/^\s*export\s+(?!type\s)[^"';]*?\sfrom\s+["']([^"']+)["']/gmu)) specs.push(match[1]);
  return specs;
}

const forbidden = (spec: string, file: string | null) =>
  spec === "next/headers"
  || spec === "@/db"
  || (file !== null && relative(root, file).startsWith(`db${"/"}`));

test("nenhum componente de navegador importa, mesmo indiretamente, código de servidor", () => {
  const clientFiles = walk(join(root, "app")).filter((file) => /^\s*["']use client["']/u.test(readFileSync(file, "utf8")));
  assert.ok(clientFiles.length > 50, "a varredura precisa encontrar os componentes de navegador");

  const violations: string[] = [];
  for (const start of clientFiles) {
    const seen = new Set<string>();
    const stack: Array<{ file: string; path: string[] }> = [{ file: start, path: [relative(root, start)] }];
    while (stack.length) {
      const { file, path } = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of valueImports(readFileSync(file, "utf8"))) {
        const target = resolveImport(file, spec);
        if (forbidden(spec, target)) {
          violations.push(`${[...path, spec].join(" → ")}`);
          continue;
        }
        if (target && !target.includes("node_modules")) stack.push({ file: target, path: [...path, relative(root, target)] });
      }
    }
  }
  assert.deepEqual(violations, [], `código de servidor alcançado a partir do navegador:\n${violations.join("\n")}`);
});
