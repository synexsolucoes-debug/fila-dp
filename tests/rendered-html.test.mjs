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

test("ships operational foundations for boards, attachments, planner, reports and SLA", async () => {
  const [hosting, schema, migration, dashboard, db, catalog, search, reports, planner, webhook, pause] = await Promise.all([
    source(".openai/hosting.json"),
    source("db/schema.ts"),
    source("drizzle/0006_sla_pause_fields.sql"),
    source("app/painel/WorkspaceApp.tsx"),
    source("lib/fila-dp-db.ts"),
    source("app/api/catalog/route.ts"),
    source("app/api/search/route.ts"),
    source("app/api/reports/route.ts"),
    source("app/api/planner/blocks/route.ts"),
    source("app/api/integrations/webhook/[channel]/route.ts"),
    source("app/api/cards/[id]/sla/pause/route.ts"),
  ]);
  assert.match(hosting, /"r2":\s*"ATTACHMENTS"/);
  for (const table of ["fdp_labels", "fdp_custom_fields", "fdp_card_attachments", "fdp_process_templates", "fdp_workspace_settings", "fdp_business_holidays", "fdp_sla_policies", "fdp_notifications", "fdp_integrations", "fdp_planner_blocks", "fdp_calendar_connections", "fdp_card_sla_pauses"]) assert.match(schema + db + migration, new RegExp(table));
  assert.match(dashboard, /Kanban/);
  assert.match(dashboard, /Tabela/);
  assert.match(dashboard, /Calendário/);
  assert.match(dashboard, /Editor No-Code/);
  assert.match(dashboard, /Bloco de tempo/);
  assert.match(dashboard, /Pausar SLA/);
  assert.match(catalog, /resource === "rule"/);
  assert.match(search, /LIMIT 50/);
  assert.match(reports, /averageCompletionHours/);
  assert.match(planner, /fdp_planner_blocks/);
  assert.match(webhook, /FDP_\$\{channel\.toUpperCase\(\)\}_WEBHOOK_SECRET/);
  assert.match(pause, /sla\.paused/);
});

test("keeps the responsive visual layer for the new surfaces", async () => {
  const css = await source("app/access.css");
  assert.match(css, /demand-table-view/);
  assert.match(css, /demand-calendar-view/);
  assert.match(css, /notification-drawer/);
  assert.match(css, /workspace-settings-layout/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
});
