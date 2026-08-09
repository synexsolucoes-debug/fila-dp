import { ApiError } from "./api-errors";

export function addBusinessDays(start: string, days: number, businessDays: number[], holidays: Set<string>) {
  const cursor = new Date(`${start}T12:00:00Z`);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (businessDays.includes(cursor.getUTCDay()) && !holidays.has(iso)) remaining -= 1;
  }
  return cursor.toISOString().slice(0, 10);
}

function stringIds(value: unknown) {
  return Array.isArray(value) ? Array.from(new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 100).slice(0, 50))) : [];
}

export async function replaceCardRelations(
  d1: D1Database,
  workspaceId: string,
  cardId: string,
  body: Record<string, unknown>,
) {
  const statements: D1PreparedStatement[] = [];
  let primaryAssigneeName: string | null = null;

  if (body.assigneeIds !== undefined) {
    const requestedIds = stringIds(body.assigneeIds);
    const members = requestedIds.length
      ? await d1.prepare(`SELECT u.id, u.name FROM fdp_users u JOIN fdp_workspace_members wm ON wm.user_id = u.id
          WHERE wm.workspace_id = ? AND u.id IN (${requestedIds.map(() => "?").join(",")}) AND wm.role IN ('admin','member')`)
        .bind(workspaceId, ...requestedIds).all<Record<string, unknown>>()
      : { results: [] };
    if (members.results.length !== requestedIds.length) throw ApiError.badRequest("Um ou mais responsáveis são inválidos.", "INVALID_ASSIGNEES");
    statements.push(d1.prepare("DELETE FROM fdp_card_assignees WHERE card_id = ?").bind(cardId));
    for (const member of members.results) {
      statements.push(d1.prepare("INSERT INTO fdp_card_assignees (workspace_id, card_id, user_id) VALUES (?, ?, ?)").bind(workspaceId, cardId, String(member.id)));
    }
    primaryAssigneeName = members.results.length ? String(members.results[0].name) : "";
    statements.push(d1.prepare("UPDATE fdp_cards SET assignee_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(primaryAssigneeName, cardId));
  }

  if (body.labelIds !== undefined) {
    const requestedIds = stringIds(body.labelIds);
    const valid = requestedIds.length
      ? await d1.prepare(`SELECT id FROM fdp_labels WHERE workspace_id = ? AND id IN (${requestedIds.map(() => "?").join(",")})`).bind(workspaceId, ...requestedIds).all<Record<string, unknown>>()
      : { results: [] };
    if (valid.results.length !== requestedIds.length) throw ApiError.badRequest("Uma ou mais etiquetas são inválidas.", "INVALID_LABELS");
    statements.push(d1.prepare("DELETE FROM fdp_card_labels WHERE card_id = ?").bind(cardId));
    for (const label of valid.results) statements.push(d1.prepare("INSERT INTO fdp_card_labels (workspace_id, card_id, label_id) VALUES (?, ?, ?)").bind(workspaceId, cardId, String(label.id)));
  }

  if (body.customValues !== undefined) {
    const values = body.customValues && typeof body.customValues === "object" && !Array.isArray(body.customValues)
      ? body.customValues as Record<string, unknown>
      : {};
    const definitions = await d1.prepare("SELECT id, field_key, field_type, options_json, required FROM fdp_custom_fields WHERE workspace_id = ?").bind(workspaceId).all<Record<string, unknown>>();
    const allowedKeys = new Set(definitions.results.map((field) => String(field.field_key)));
    for (const key of Object.keys(values)) if (!allowedKeys.has(key)) throw ApiError.badRequest("Campo personalizado inválido.", "INVALID_CUSTOM_FIELD");
    for (const field of definitions.results) {
      const key = String(field.field_key);
      const raw = values[key];
      const value = raw === undefined || raw === null ? "" : String(raw).trim().slice(0, 500);
      if (Boolean(field.required) && !value) throw ApiError.badRequest(`O campo ${key} é obrigatório.`, "REQUIRED_CUSTOM_FIELD");
      if (String(field.field_type) === "number" && value && !Number.isFinite(Number(value))) throw ApiError.badRequest(`O campo ${key} deve ser numérico.`, "INVALID_CUSTOM_FIELD");
      if (String(field.field_type) === "date" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw ApiError.badRequest(`O campo ${key} contém data inválida.`, "INVALID_CUSTOM_FIELD");
      if (String(field.field_type) === "select" && value) {
        const options = JSON.parse(String(field.options_json || "[]")) as string[];
        if (!options.includes(value)) throw ApiError.badRequest(`Opção inválida para ${key}.`, "INVALID_CUSTOM_FIELD");
      }
      statements.push(d1.prepare(`INSERT INTO fdp_custom_field_values (workspace_id, card_id, field_id, value_text, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(card_id, field_id) DO UPDATE SET value_text = excluded.value_text, updated_at = CURRENT_TIMESTAMP`).bind(workspaceId, cardId, String(field.id), value));
    }
  }

  if (statements.length) await d1.batch(statements);
  return { primaryAssigneeName };
}
