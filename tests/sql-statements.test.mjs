import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { splitPostgresStatements } from "../scripts/sql-statements.mjs";

test("preserva blocos PostgreSQL com pontos e vírgulas internos", () => {
  const statements = splitPostgresStatements(`
    CREATE TABLE example (id text);
    --> statement-breakpoint
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM example) THEN
        RAISE EXCEPTION 'preflight failed: example';
      END IF;
    END $$;
    CREATE POLICY tenant_policy ON example
      USING (id = current_setting('app.workspace_id', true));
  `);

  assert.equal(statements.length, 3);
  assert.match(statements[1], /^--> statement-breakpoint\s+DO \$\$/);
  assert.match(statements[1], /RAISE EXCEPTION 'preflight failed: example';/);
  assert.match(statements[2], /current_setting\('app\.workspace_id', true\)/);
});

test("não separa ponto e vírgula em strings, identificadores, comentários ou dollar quotes nomeados", () => {
  const statements = splitPostgresStatements(`
    SELECT ';' AS "semi;colon" /* ; /* nested ; */ ; */;
    -- ; is not a statement
    DO $migration$ BEGIN PERFORM ';'; END $migration$;
  `);

  assert.equal(statements.length, 2);
  assert.match(statements[0], /nested/);
  assert.match(statements[1], /\$migration\$ BEGIN PERFORM ';'; END \$migration\$/);
});

test("rejeita SQL com delimitador aberto", () => {
  assert.throws(() => splitPostgresStatements("DO $$ BEGIN PERFORM 1;"), /delimitador não encerrado/);
});


/**
 * Cast de texto possivelmente vazio para instante.
 *
 * `(? = '' OR criado_em < ?::timestamptz)` **passa** no `PREPARE` e **falha** na
 * execução: PostgreSQL converte o literal antes de decidir a condição, e `''`
 * não é um instante. O sintoma é cruel — a primeira página funciona e a
 * consulta sem cursor devolve 500 —, e o verificador de SQL inline não pega,
 * porque ele prepara sem executar.
 *
 * A forma correta é `NULLIF(?, '')::timestamptz`, que converte o vazio em nulo
 * antes do cast.
 */
test("nenhuma consulta converte texto possivelmente vazio em instante", async () => {
  const raiz = new URL("../app/api/", import.meta.url);
  const suspeitas = [];

  async function varrer(diretorio) {
    for (const entrada of await readdir(diretorio, { withFileTypes: true })) {
      const alvo = new URL(`${entrada.name}${entrada.isDirectory() ? "/" : ""}`, diretorio);
      if (entrada.isDirectory()) { await varrer(alvo); continue; }
      if (!entrada.name.endsWith(".ts")) continue;
      const conteudo = await readFile(alvo, "utf8");
      for (const [linha, texto] of conteudo.split("\n").entries()) {
        // O guarda `? = ''` ao lado de um cast direto é a assinatura exata do
        // defeito; `NULLIF` na mesma linha é a forma correta e não acusa.
        if (/=\s*''/u.test(texto) && /\?::timestamptz/u.test(texto) && !/NULLIF/u.test(texto)) {
          suspeitas.push(`${alvo.pathname.split("/app/")[1]}:${linha + 1}`);
        }
      }
    }
  }

  await varrer(raiz);
  assert.deepEqual(suspeitas, [],
    "cast de parâmetro possivelmente vazio para timestamptz: use NULLIF(?, '')::timestamptz");
});
