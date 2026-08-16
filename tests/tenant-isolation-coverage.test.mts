import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §8: multi-tenancy é prioridade máxima — e a prova precisa cobrir o schema.
 *
 * `scripts/verify-tenant-isolation.mjs` roda na CI desde sempre e imprimia
 * "ISOLAMENTO APROVADO neste banco". Ele provava isolamento em `fdp_companies`:
 * uma tabela de noventa e uma que carregam `workspace_id`. Cinco verificações
 * sobre 1/91, e um veredito escrito no plural.
 *
 * Ao estender para o schema inteiro, a primeira execução encontrou quatro
 * tabelas com `workspace_id` e sem RLS, e provou uma leitura entre clientes em
 * `fdp_workspace_members`. Três dessas quatro são globais por desenho e agora
 * dizem por quê; a quarta, `fdp_member_company_access`, não tinha motivo
 * nenhum — era dado de cliente e autorização sem proteção do banco.
 */

const script = await readFile(new URL("../scripts/verify-tenant-isolation.mjs", import.meta.url), "utf8");

test("o ensaio percorre toda tabela com workspace_id, não uma", () => {
  assert.match(script, /information_schema\.columns col/u);
  assert.match(script, /col\.column_name = 'workspace_id'/u);
  // Duas provas por tabela: a proteção existe, e ela de fato barra o outro tenant.
  assert.match(script, /toda tabela com workspace_id tem RLS forçada/u);
  assert.match(script, /entrega dado do outro tenant/u);
  assert.match(script, /c\.relrowsecurity AS rls, c\.relforcerowsecurity AS forcada/u);
});

test("a exceção à RLS exige motivo escrito, não só ausência de reclamação", () => {
  const lista = script.slice(script.indexOf("const GLOBAIS_POR_DESENHO"), script.indexOf("const semRls"));
  for (const tabela of ["fdp_workspace_members", "fdp_workspaces", "fdp_workspace_deletions", "fdp_bootstrap_guard"]) {
    assert.match(lista, new RegExp(`"${tabela}", "`, "u"), `${tabela} sem motivo declarado`);
  }
  // O motivo da principal precisa ser o real: sem essa leitura, ninguém entra.
  assert.match(lista, /antes de existir contexto de workspace; com RLS por tenant, ninguém entraria/u);
  // Quem não está na lista e não tem RLS reprova.
  assert.match(script, /sem proteção e sem motivo declarado/u);
});

test("a tabela de acesso por empresa ganhou RLS", async () => {
  // Ela decide quais empresas um membro enxerga: é dado de cliente e é
  // autorização. Não havia vazamento — as catorze consultas do produto contra
  // ela correlacionam por `workspace_id` —, mas a proteção era só disciplina.
  const migration = await readFile(new URL("../drizzle/postgres/0042_member_company_access_rls.sql", import.meta.url), "utf8");
  assert.match(migration, /ALTER TABLE "fdp_member_company_access" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "fdp_member_company_access" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /USING \("workspace_id" = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)\)/u);
  assert.match(migration, /WITH CHECK \("workspace_id" = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)\)/u);

  const journal = JSON.parse(await readFile(new URL("../drizzle/postgres/meta/_journal.json", import.meta.url), "utf8")) as
    { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0042_member_company_access_rls"));
});

test("o ensaio continua reprovando o banco inteiro quando alguma tabela cai", () => {
  // Verificado desligando a RLS de `fdp_cards`: o ensaio saiu com código 1 e
  // nomeou a tabela. Religada, voltou a 0.
  assert.match(script, /ISOLAMENTO REPROVADO/u);
  assert.match(script, /process\.exit\(1\)/u);
});

test("o verificador de SQL mede o produto, não os próprios ensaios", async () => {
  // Consulta escrita dentro de um teste é fixture — texto para o teste
  // examinar. Contá-la misturava a cobertura do produto com a do ensaio.
  const coletor = await readFile(new URL("../scripts/inline-sql.mjs", import.meta.url), "utf8");
  assert.match(coletor, /"\.vercel", "tests"/u);
});
