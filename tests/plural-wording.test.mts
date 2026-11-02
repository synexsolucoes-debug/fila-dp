import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contagem } from "../app/painel/features/shared/plural.ts";

/**
 * "3 demandas abertas", não "3 demanda(s) aberta(s)".
 *
 * O "(s)" obrigava quem lê a montar a frase de cabeça. Eram 174 nas telas.
 * Esta prova impede que o atalho volte em texto de interface depois de um
 * número interpolado.
 */
const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("contagem escolhe singular e plural", () => {
  assert.equal(contagem(1, "demanda aberta", "demandas abertas"), "1 demanda aberta");
  assert.equal(contagem(0, "demanda aberta", "demandas abertas"), "0 demandas abertas");
  assert.equal(contagem(3, "registro impede", "registros impedem"), "3 registros impedem");
});

test("texto de tela não usa (s) depois de número interpolado", () => {
  const ofensas: string[] = [];
  for (const file of walk(join(root, "app"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/\}\s[A-Za-zÀ-ÿ]+\((?:s|es)\)/u.test(line)) ofensas.push(`${relative(root, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(ofensas, [], `use contagem() de app/painel/features/shared/plural.ts:\n${ofensas.join("\n")}`);
});
