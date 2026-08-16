import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §54: consultas por linha.
 *
 * Medido contra PostgreSQL local, 31 marcações (um mês de um colaborador):
 * o laço sequencial leva 10,6ms, o comando único 1,1ms — 9,5x. Local a
 * diferença é pequena porque a ida e volta custa ~0,1ms. Em produção o driver
 * é HTTP e cada `.run()` é uma requisição própria: projetado a 25ms de ida e
 * volta, são 785ms contra 26ms; a 50ms, 1,5s contra 51ms.
 *
 * O que não muda: o `ON CONFLICT` continua igual, então reenviar a competência
 * inteira segue atualizando em vez de duplicar. Conferido contra o banco —
 * 31 linhas, reenvio, 31 linhas.
 */

const service = await readFile(new URL("../lib/time-service.ts", import.meta.url), "utf8");

test("gravar marcações é um comando, não um por dia", () => {
  const fn = service.slice(service.indexOf("export async function saveTimeEntries"));
  const corpo = fn.slice(0, fn.indexOf("\n}\n"));
  // O laço continua existindo — ele monta a lista de valores. O que não pode
  // voltar é `await` dentro dele: é o `await` que faz uma ida por linha.
  // (Regex ingênua com `[\s\S]*?` casaria com o `await` que vem *depois* do
  // laço, acusando o contrário do que se quer.)
  const laco = corpo.slice(corpo.indexOf("for (const entry of input.entries) {"));
  const dentroDoLaco = laco.slice(0, laco.indexOf("\n  }"));
  assert.doesNotMatch(dentroDoLaco, /\bawait\b/u, "voltou a gravar linha a linha");
  assert.match(corpo, /VALUES \$\{linhas\}/u);
  // O comportamento de reenvio é o que torna a competência reprocessável.
  assert.match(corpo, /ON CONFLICT \(workspace_id, time_sheet_id, entry_date\) DO UPDATE/u);
});

test("eventos apurados e folhas exportadas também vão num comando", () => {
  assert.match(service, /const apurados = totals\.events\.filter/u);
  assert.match(service, /apurados\.map\(\(\) => "\(\?, \?, \?, \?, \?, 'computed', \?\)"\)\.join\(", "\)/u);
  assert.match(service, /WHERE workspace_id = \? AND status = 'approved' AND id IN \(\$\{folhas\.map/u);
});

test("as inconsistências vão num lote, numa transação", () => {
  // Três operações — apagar as que sumiram, atualizar as que mudaram, inserir
  // as novas — eram três idas por inconsistência. E uma folha com problema é
  // justamente a que tem muitas.
  assert.match(service, /if \(comandos\.length\) await d1\.batch\(comandos\);/u);
  assert.match(service, /DELETE FROM fdp_time_inconsistencies WHERE workspace_id = \? AND id IN \(/u);
});

test("o verificador de SQL confere as consultas montadas com interpolação", async () => {
  // Sessenta e duas consultas do produto — inclusive as de escrita em lote —
  // nunca eram conferidas contra o schema: bastava a consulta ter um `${}`.
  const script = await readFile(new URL("../scripts/verify-inline-sql.mts", import.meta.url), "utf8");
  assert.match(script, /function substituicoes\(sql: string\)/u);
  // A aridade vem da lista de colunas do INSERT. Sem isso a substituição não
  // chega a preparar, e a consulta cai em "não verificada" sem reprovar nada.
  assert.match(script, /const colunas = insert\[1\]\.split\(","\)/u);

  // E o teto: sem ele, uma consulta que quebra apenas *muda de coluna* no
  // relatório — sai de "verificada" e entra em "não verificada" — e o total de
  // falhas continua zero. Verificado introduzindo uma coluna inexistente: com
  // o teto o processo sai com código 1; sem ele, saía com 0.
  assert.match(script, /const MAXIMO_NAO_VERIFICADAS = \d+;/u);
  assert.match(script, /Regressão de cobertura/u);
  assert.match(script, /if \(skipped > MAXIMO_NAO_VERIFICADAS\)/u);
});
