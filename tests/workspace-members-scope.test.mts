import assert from "node:assert/strict";
import test from "node:test";

import { collectQueries } from "../scripts/inline-sql.mjs";

/**
 * A exceção de RLS de `fdp_workspace_members` (§51).
 *
 * Três tabelas do produto não têm Row Level Security, e a exceção é legítima:
 * `fdp_users`, `fdp_workspaces` e `fdp_workspace_members` precisam ser lidas
 * **antes** de existir um tenant. É delas que sai a resposta para "a que grupos
 * esta pessoa pertence?", e essa pergunta antecede a definição de
 * `app.workspace_id`. Ligar RLS ali trancaria o login para fora do produto.
 *
 * O risco que isso cria é claro: nesta tabela, a única barreira contra ler o
 * quadro de pessoal de outro cliente é a cláusula `WHERE` da consulta. Uma
 * consulta nova que esqueça o filtro não é recusada por nada.
 *
 * Este teste é a barreira que faltava. Toda consulta que toca a tabela precisa
 * filtrar por `workspace_id` **ou** estar nomeada abaixo, com o motivo. Não
 * impede a exceção — impede a exceção **silenciosa**, que é o que acontece
 * quando alguém copia uma consulta vizinha sem perceber o que ela não tem.
 */

/**
 * As exceções conscientes, por arquivo.
 *
 * Duas famílias, e só duas:
 *
 * 1. **Autenticação**, que roda antes de existir workspace resolvido;
 * 2. **Console da plataforma**, cujo trabalho é justamente ver todos os grupos —
 *    e que tem contexto próprio, allowlist de operador e auditoria global.
 *
 * Qualquer arquivo fora destes dois grupos que precise entrar aqui é sinal de
 * que a consulta está no lugar errado, não de que a lista está curta.
 */
const EXCECOES: Record<string, string> = {
  "app/api/auth/login/route.ts":
    "o login pergunta se a pessoa pertence a algum grupo — antes disso não existe workspace",
  "app/api/platform/users/route.ts":
    "console global: listar identidades de todos os clientes é a função da tela",
  "app/api/platform/users/[id]/route.ts":
    "console global: administrar uma identidade atravessa os grupos dela",
  "app/api/platform/users/[id]/detail/route.ts":
    "console global: o detalhe mostra cada associação da pessoa",
  "app/api/platform/workspaces/route.ts":
    "console global: a lista de clientes conta membros por grupo",
  "app/api/platform/workspaces/[id]/route.ts":
    "console global: administrar o contrato de um cliente",
};

const queries = collectQueries(process.cwd())
  .map((query) => ({ ...query, file: query.file.replaceAll("\\", "/") }))
  .filter((query) => /fdp_workspace_members/u.test(query.sql));

/** A consulta recorta o tenant? Aceita o parâmetro e a coluna correlacionada. */
function filtraPorWorkspace(sql: string) {
  return /workspace_id\s*=\s*\?/u.test(sql)
    || /workspace_id\s*=\s*\$\d/u.test(sql)
    || /wm\.workspace_id\s*=\s*\w+\.workspace_id/u.test(sql);
}

test("existem consultas nesta tabela para o teste ter o que proteger", () => {
  assert.ok(queries.length > 10, `esperava várias consultas, encontrei ${queries.length}`);
});

test("toda consulta a fdp_workspace_members recorta o grupo ou é exceção declarada", () => {
  const semFiltro = queries
    .filter((query) => !filtraPorWorkspace(query.sql))
    .filter((query) => !Object.hasOwn(EXCECOES, query.file));

  assert.deepEqual(
    semFiltro.map((query) => `${query.file}:${query.line}`),
    [],
    "consulta sem recorte de grupo em tabela sem RLS: filtre por workspace_id, "
    + "ou declare a exceção em tests/workspace-members-scope.test.mts com o motivo",
  );
});

test("a lista de exceções não guarda entrada que deixou de ser necessária", () => {
  // Exceção que sobra é exceção que ninguém revisa: ela vira permissão
  // permanente para o próximo arquivo com o mesmo nome.
  const arquivosComExcecaoReal = new Set(
    queries.filter((query) => !filtraPorWorkspace(query.sql)).map((query) => query.file),
  );
  const orfas = Object.keys(EXCECOES).filter((file) => !arquivosComExcecaoReal.has(file));
  assert.deepEqual(orfas, [], "remova da lista as exceções que já filtram por workspace");
});

test("nenhuma exceção nova entra fora da autenticação e do console da plataforma", () => {
  for (const file of Object.keys(EXCECOES)) {
    assert.ok(
      file.startsWith("app/api/auth/") || file.startsWith("app/api/platform/"),
      `exceção fora das duas famílias permitidas: ${file}`,
    );
  }
});

test("cada exceção declara o motivo, e não só o caminho", () => {
  for (const [file, motivo] of Object.entries(EXCECOES)) {
    assert.ok(motivo.length > 30, `exceção sem justificativa útil: ${file}`);
  }
});
