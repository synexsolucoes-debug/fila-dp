import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectQueries, extractQueries, findReservedIdentifiers, RESERVED_KEYWORDS } from "../scripts/inline-sql.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * O defeito que estes testes protegem, com nome e sobrenome:
 *
 *   JOIN fdp_workspace_module_grants grant ON grant.workspace_id = ...
 *
 * `grant` é palavra totalmente reservada no PostgreSQL. Como apelido ela derruba
 * a consulta inteira com `syntax error at or near "grant"`. A consulta estava na
 * varredura agendada das integrações, fora de qualquer `try` por workspace, então
 * o erro não parava uma integração: parava a varredura toda, para todos os
 * clientes, a cada meia hora. Sincronizar enfileirava trabalho que nunca saía da
 * fila, e nenhum teste via nada, porque o SQL do produto é string e ninguém
 * conferia string.
 *
 * O teste é do repositório inteiro de propósito. Proteger só o arquivo corrigido
 * deixaria a próxima consulta escrever `user`, `order` ou `check` como apelido e
 * repetir a história.
 */

test("nenhuma consulta do produto usa palavra reservada do PostgreSQL como identificador", () => {
  const queries = collectQueries(repositoryRoot);
  // Se a extração parar de achar consultas, o teste passa sem verificar nada.
  assert.ok(queries.length > 500, `esperava centenas de consultas, encontrei ${queries.length}`);

  const offenders = queries.flatMap((query) =>
    findReservedIdentifiers(query.sql).map((finding) =>
      `${query.file}:${query.line}: ${finding.kind === "alias" ? "apelido" : "tabela"} "${finding.identifier}" em ${finding.clause} ${finding.table}`));

  assert.deepEqual(offenders, [], `palavra reservada do PostgreSQL usada como identificador:\n${offenders.join("\n")}`);
});

test("o detector reconhece o caso que quebrou a produção", () => {
  const findings = findReservedIdentifiers(
    `SELECT integration.id FROM fdp_integrations integration
     JOIN fdp_workspace_module_grants grant ON grant.workspace_id = integration.workspace_id`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].identifier, "grant");
  assert.equal(findings[0].kind, "alias");
});

test("o detector aceita o apelido corrigido e não acusa cláusula como apelido", () => {
  assert.deepEqual(findReservedIdentifiers(
    `SELECT integration.id FROM fdp_integrations integration
     JOIN fdp_workspace_module_grants module_grant ON module_grant.workspace_id = integration.workspace_id`), []);

  // `WHERE`, `ORDER`, `GROUP` e `LIMIT` seguem o nome da tabela sem serem apelido.
  assert.deepEqual(findReservedIdentifiers("SELECT id FROM fdp_cards WHERE workspace_id = ? ORDER BY created_at LIMIT 10"), []);
  assert.deepEqual(findReservedIdentifiers("UPDATE fdp_cards SET title = ? WHERE id = ?"), []);
  assert.deepEqual(findReservedIdentifiers("INSERT INTO fdp_cards (id, title) VALUES (?, ?)"), []);
});

test("palavra reservada dentro de string ou comentário não é acusada", () => {
  assert.deepEqual(findReservedIdentifiers("SELECT id FROM fdp_audit_events WHERE action = 'grant' AND entity_type = 'user'"), []);
  assert.deepEqual(findReservedIdentifiers("SELECT id FROM fdp_modules module -- grant aqui é comentário\n WHERE module.key = ?"), []);
});

test("`AS` explícito não salva uma palavra reservada", () => {
  // `AS grant` falha igual: reservada é reservada, com ou sem AS.
  const findings = findReservedIdentifiers("SELECT * FROM fdp_workspace_module_grants AS grant");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].identifier, "grant");
});

test("a extração encontra consultas em template literal, com e sem interpolação", () => {
  const queries = extractQueries("exemplo.ts", [
    'const a = d1.prepare("SELECT id FROM fdp_cards WHERE workspace_id = ?");',
    "const b = d1.prepare(`SELECT id FROM ${table} WHERE workspace_id = ?`);",
    'const c = notSql.prepare("apenas texto");',
  ].join("\n"));

  assert.equal(queries.length, 2, "o que não começa com um verbo SQL fica de fora");
  assert.equal(queries[0].interpolated, false);
  assert.equal(queries[1].interpolated, true, "consulta com interpolação precisa ser marcada: o schema real não a valida sozinha");
});

test("a lista de reservadas cobre as palavras que mais aparecem como apelido inocente", () => {
  // Estas são as tentadoras: nomes que descrevem bem a tabela e quebram o SQL.
  for (const keyword of ["grant", "user", "order", "check", "table", "column", "default", "references", "window", "end"]) {
    assert.ok(RESERVED_KEYWORDS.has(keyword), `${keyword} precisa estar na lista de reservadas`);
  }
});
