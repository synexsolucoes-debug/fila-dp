import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("ships the Vinculato product instead of the temporary starter", async () => {
  const [landing, layout, dashboard, packageJson] = await Promise.all([
    source("app/page.tsx"),
    source("app/layout.tsx"),
    source("app/painel/WorkspaceApp.tsx"),
    source("package.json"),
  ]);

  assert.match(landing, /Vinculato/);
  assert.match(layout, /Vinculato/);
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
  // A conta pessoal continua tendo lugar próprio nas configurações. A
  // conferência deixa de mirar o rótulo do grupo — que virou "CONTA" quando o
  // menu foi reagrupado por assunto (§11.1) — e passa a mirar a seção em si,
  // que é o que importa aqui: ela existe e não fica atrás de administrador.
  assert.match(dashboard, /title: "Perfil e segurança"/);
  assert.match(dashboard, /\{ section: "security", icon: Smartphone, hint: "Dispositivos e sessões", adminOnly: false \}/);
  assert.doesNotMatch(dashboard, /AccessView|Plano e ativação/);
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
  // O segredo do webhook deixou de vir do ambiente e passou a ser credencial do
  // próprio workspace; o ambiente segue aceito só como compatibilidade, dentro
  // de `resolveWebhookSecret`.
  assert.match(webhook, /resolveWebhookSecret/);
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

test("keeps critical workspace and integration security boundaries", async () => {
  const [auth, listsRoute, commentsRoute, syncRoute, integrationEngine, webhookRoute] = await Promise.all([
    source("app/chatgpt-auth.ts"),
    source("app/api/lists/[id]/route.ts"),
    source("app/api/cards/[id]/comments/route.ts"),
    source("app/api/integrations/sync/route.ts"),
    source("lib/integration-engine.ts"),
    source("app/api/integrations/webhook/[channel]/route.ts"),
  ]);

  assert.match(auth, /if \(process\.env\.VERCEL\) return null/);
  assert.match(listsRoute, /b\.workspace_id = \?/);
  assert.match(listsRoute, /board_id IN \(SELECT id FROM fdp_boards WHERE workspace_id = \?\)/);
  assert.match(commentsRoute, /JOIN fdp_workspace_members/);
  assert.match(syncRoute, /queueIntegrationRun/);
  assert.match(integrationEngine, /validateConnectorEndpoint/);
  assert.match(integrationEngine, /redirect: "error"/);
  // Segredo por workspace, conferido em tempo constante, antes de qualquer
  // escrita. A variável de ambiente global saiu do caminho principal.
  assert.match(webhookRoute, /assertWebhookSecret/);
  assert.match(webhookRoute, /Payload do webhook excede 64 KB/);
});


test("comentário suporta menção, anexo e histórico contextualizado (§44)", async () => {
  const [comments, attachments, storage, painel, database, schema] = await Promise.all([
    source("app/api/cards/[id]/comments/route.ts"),
    source("app/api/cards/[id]/attachments/route.ts"),
    source("lib/card-attachments.ts"),
    source("app/painel/WorkspaceApp.tsx"),
    source("lib/fila-dp-db.ts"),
    source("db/schema.ts"),
  ]);
  assert.match(comments, /matchAll\(\/@\(/u, "menções continuam extraídas no servidor");
  assert.match(comments, /createdCommentId: commentId/u);
  assert.match(attachments, /FROM fdp_card_comments WHERE workspace_id = \? AND id = \? AND card_id = \?/u,
    "um id de comentário de outra demanda ou workspace não pode receber o arquivo");
  assert.match(storage, /process_step_id, checklist_item_id, comment_id/u);
  assert.match(schema, /fdp_card_attachments_comment_fk/u);
  assert.match(database, /commentId: item\.comment_id/u);
  assert.match(painel, /form\.set\("commentId", payload\.createdCommentId\)/u);
  assert.match(painel, /attachment\.commentId === comment\.id/u);
});
