import assert from "node:assert/strict";
import test from "node:test";
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
