import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("ships the Fila DP product instead of the temporary starter", async () => {
  const [landing, layout, dashboard, packageJson] = await Promise.all([
    source("app/page.tsx"),
    source("app/layout.tsx"),
    source("app/painel/WorkspaceApp.tsx"),
    source("package.json"),
  ]);

  assert.match(landing, /Fila DP/);
  assert.match(layout, /Fila DP/);
  assert.match(dashboard, /Caixa de entrada/);
  assert.match(dashboard, /Meu planner/);
  assert.match(dashboard, /Indicadores/);
  assert.doesNotMatch(landing + layout, /codex-preview|Your site is taking shape/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("app/_sites-preview", root)));
});

test("keeps collaboration and authorization wired to durable workspace data", async () => {
  const [schema, database, dashboard, membersRoute, commentsRoute] = await Promise.all([
    source("db/schema.ts"),
    source("lib/fila-dp-db.ts"),
    source("app/painel/WorkspaceApp.tsx"),
    source("app/api/members/route.ts"),
    source("app/api/cards/[id]/comments/route.ts"),
  ]);

  assert.match(schema, /fdp_workspace_members/);
  assert.match(schema, /fdp_card_comments/);
  assert.match(schema, /fdp_user_workspace_preferences/);
  assert.match(database, /requireWorkspaceRole/);
  assert.match(membersRoute, /\["admin"\]/);
  assert.match(commentsRoute, /\["admin", "member", "guest"\]/);
  assert.match(dashboard, /EQUIPE E ACESSO/);
  assert.match(dashboard, /COMENTÁRIOS/);
  assert.match(dashboard, /HISTÓRICO/);
});
