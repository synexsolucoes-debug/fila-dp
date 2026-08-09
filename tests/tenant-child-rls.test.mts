import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("child records carry tenant identity with composite integrity and forced RLS", async () => {
  const [schema, migration, cardsRoute, relations] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0010_child_tenant_rls.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/cards/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/fila-dp-relations.ts", import.meta.url), "utf8"),
  ]);
  for (const table of ["lists", "cards", "checklistItems", "cardComments", "cardLabels", "cardAssignees", "customFieldValues", "cardAttachments"]) {
    const declaration = schema.slice(schema.indexOf(`export const ${table}`));
    assert.match(declaration.slice(0, 1500), /workspaceId:\s*text\("workspace_id"\)\.notNull\(\)/, `${table} must carry workspace_id`);
  }
  assert.match(schema, /fdp_cards_workspace_board_list_fk/);
  assert.match(schema, /fdp_card_labels_workspace_label_fk/);
  assert.match(schema, /fdp_custom_field_values_workspace_field_fk/);
  assert.match(migration, /tenant integrity preflight failed: fdp_cards relationships/);
  assert.match(migration, /FOREIGN KEY \("workspace_id", "board_id", "list_id"\)/);
  assert.match(migration, /fdp_boards_workspace_isolation/);
  assert.match(migration, /fdp_notifications_workspace_isolation/);
  assert.match(migration, /fdp_calendar_connections_workspace_isolation/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(cardsRoute, /INSERT INTO fdp_cards\s+\(id, workspace_id,/);
  assert.match(relations, /INSERT INTO fdp_card_labels \(workspace_id, card_id, label_id\)/);
  assert.match(relations, /INSERT INTO fdp_custom_field_values \(workspace_id, card_id, field_id,/);
});
