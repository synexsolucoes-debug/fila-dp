type ProcessStageSnapshot = { id: string; name: string; kind: string; position: number; slaBehavior: string };

function safeRecord(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "{}")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function processSnapshot(d1: D1Database, boardId: string) {
  const [stages, rules] = await Promise.all([
    d1.prepare("SELECT id, name, kind, position, sla_behavior FROM fdp_lists WHERE board_id = ? ORDER BY position")
      .bind(boardId)
      .all<{ id: string; name: string; kind: string; position: number; sla_behavior: string }>(),
    d1.prepare("SELECT id, name, trigger, condition_json, action_json, enabled, position FROM fdp_automation_rules WHERE board_id = ? ORDER BY position")
      .bind(boardId)
      .all<Record<string, unknown>>(),
  ]);
  return {
    stages: stages.results.map<ProcessStageSnapshot>((stage) => ({
      id: stage.id,
      name: stage.name,
      kind: stage.kind,
      position: Number(stage.position),
      slaBehavior: stage.sla_behavior,
    })),
    rules: rules.results.map((rule) => ({
      id: String(rule.id),
      name: String(rule.name),
      trigger: String(rule.trigger),
      condition: safeRecord(rule.condition_json),
      action: safeRecord(rule.action_json),
      enabled: Boolean(rule.enabled),
      position: Number(rule.position),
    })),
  };
}

export async function ensureProcessVersion(d1: D1Database, boardId: string, actorEmail: string) {
  const board = await d1.prepare("SELECT process_version FROM fdp_boards WHERE id = ?").bind(boardId).first<{ process_version: number }>();
  if (!board) throw new Error("Processo não encontrado.");
  const version = Number(board.process_version ?? 1);
  const snapshot = await processSnapshot(d1, boardId);
  await d1.prepare(`INSERT INTO fdp_process_versions (id, board_id, version, snapshot_json, created_by)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(board_id, version) DO NOTHING`)
    .bind(crypto.randomUUID(), boardId, version, JSON.stringify(snapshot), actorEmail)
    .run();
  return version;
}

export async function publishProcessVersion(d1: D1Database, boardId: string, actorEmail: string) {
  const current = await ensureProcessVersion(d1, boardId, actorEmail);
  const next = current + 1;
  await d1.prepare("UPDATE fdp_boards SET process_version = ? WHERE id = ? AND process_version = ?").bind(next, boardId, current).run();
  const board = await d1.prepare("SELECT process_version FROM fdp_boards WHERE id = ?").bind(boardId).first<{ process_version: number }>();
  const publishedVersion = Number(board?.process_version ?? next);
  const snapshot = await processSnapshot(d1, boardId);
  await d1.prepare(`INSERT INTO fdp_process_versions (id, board_id, version, snapshot_json, created_by)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(board_id, version) DO UPDATE SET snapshot_json = excluded.snapshot_json`)
    .bind(crypto.randomUUID(), boardId, publishedVersion, JSON.stringify(snapshot), actorEmail)
    .run();
  return publishedVersion;
}
