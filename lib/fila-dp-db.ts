import { getD1 } from "../db";
import type { ChatGPTUser } from "../app/chatgpt-auth";
import type { WorkspaceRole, WorkspaceSnapshot } from "./fila-dp-types";

let schemaPromise: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS fdp_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    owner_user_id TEXT NOT NULL UNIQUE REFERENCES fdp_users(id),
    timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_workspace_members (
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES fdp_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin',
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_user_workspace_preferences (
    user_id TEXT PRIMARY KEY REFERENCES fdp_users(id) ON DELETE CASCADE,
    active_workspace_id TEXT REFERENCES fdp_workspaces(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_boards (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    board_type TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_lists (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES fdp_boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position REAL NOT NULL,
    sla_behavior TEXT NOT NULL DEFAULT 'running',
    UNIQUE (board_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_cards (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES fdp_boards(id) ON DELETE CASCADE,
    list_id TEXT NOT NULL REFERENCES fdp_lists(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    process_type TEXT NOT NULL DEFAULT 'OUTROS',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee_name TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    sla_status TEXT NOT NULL DEFAULT 'safe',
    position REAL NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'manual',
    archived INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_checklist_items (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_card_comments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES fdp_cards(id) ON DELETE CASCADE,
    author_user_id TEXT NOT NULL REFERENCES fdp_users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_workspace_inbox_items (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'manual',
    sender_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    converted_card_id TEXT REFERENCES fdp_cards(id)
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_automation_rules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    condition_json TEXT NOT NULL DEFAULT '{}',
    action_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    position REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fdp_activity_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES fdp_workspaces(id) ON DELETE CASCADE,
    card_id TEXT REFERENCES fdp_cards(id) ON DELETE CASCADE,
    actor_email TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS fdp_cards_board_list_position_idx ON fdp_cards (board_id, list_id, position)",
  "CREATE INDEX IF NOT EXISTS fdp_cards_due_status_idx ON fdp_cards (due_at, sla_status)",
  "CREATE INDEX IF NOT EXISTS fdp_checklist_card_position_idx ON fdp_checklist_items (card_id, position)",
  "CREATE INDEX IF NOT EXISTS fdp_comments_card_created_idx ON fdp_card_comments (card_id, created_at)",
  "CREATE INDEX IF NOT EXISTS fdp_inbox_workspace_status_received_idx ON fdp_workspace_inbox_items (workspace_id, status, received_at)",
  "CREATE INDEX IF NOT EXISTS fdp_activity_workspace_created_idx ON fdp_activity_events (workspace_id, created_at)",
];

export async function ensureSchema() {
  if (!schemaPromise) {
    const d1 = getD1();
    schemaPromise = d1.batch(schemaStatements.map((statement) => d1.prepare(statement))).then(() => undefined);
  }
  return schemaPromise;
}

function dateOffset(days: number) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function getWorkspaceContext(user: ChatGPTUser) {
  await ensureSchema();
  const d1 = getD1();
  const normalizedEmail = user.email.trim().toLowerCase();

  await d1.prepare("INSERT OR IGNORE INTO fdp_users (id, email, name) VALUES (?, ?, ?)")
    .bind(crypto.randomUUID(), normalizedEmail, user.displayName)
    .run();
  await d1.prepare("UPDATE fdp_users SET name = ? WHERE email = ?")
    .bind(user.displayName, normalizedEmail)
    .run();

  const userRow = await d1.prepare("SELECT id, email, name FROM fdp_users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: string; email: string; name: string }>();
  if (!userRow) throw new Error("Não foi possível criar o usuário.");

  let workspace = await d1.prepare(
    `SELECT w.id, w.name, w.timezone, wm.role
     FROM fdp_user_workspace_preferences p
     JOIN fdp_workspaces w ON w.id = p.active_workspace_id
     JOIN fdp_workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = p.user_id
     WHERE p.user_id = ?
     LIMIT 1`,
  ).bind(userRow.id).first<{ id: string; name: string; timezone: string; role: WorkspaceRole }>();

  if (!workspace) {
    workspace = await d1.prepare(
      `SELECT w.id, w.name, w.timezone, wm.role
       FROM fdp_workspaces w
       JOIN fdp_workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = ?
       ORDER BY CASE WHEN w.owner_user_id = ? THEN 0 ELSE 1 END, wm.joined_at
       LIMIT 1`,
    ).bind(userRow.id, userRow.id).first<{ id: string; name: string; timezone: string; role: WorkspaceRole }>();
  }

  if (!workspace) {
    const workspaceId = crypto.randomUUID();
    const slugSuffix = userRow.id.replaceAll("-", "").slice(0, 8);
    await d1.batch([
      d1.prepare("INSERT OR IGNORE INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)")
        .bind(workspaceId, "Synex DP", `synex-dp-${slugSuffix}`, userRow.id),
      d1.prepare("INSERT OR IGNORE INTO fdp_workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')")
        .bind(workspaceId, userRow.id),
      d1.prepare("INSERT OR REPLACE INTO fdp_user_workspace_preferences (user_id, active_workspace_id, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .bind(userRow.id, workspaceId),
    ]);
    workspace = await d1.prepare(
      `SELECT w.id, w.name, w.timezone, wm.role
       FROM fdp_workspaces w
       JOIN fdp_workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = ? LIMIT 1`,
    ).bind(userRow.id).first<{ id: string; name: string; timezone: string; role: WorkspaceRole }>();
  }
  if (!workspace) throw new Error("Não foi possível criar o workspace.");

  await d1.prepare(
    `INSERT INTO fdp_user_workspace_preferences (user_id, active_workspace_id, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = excluded.active_workspace_id, updated_at = CURRENT_TIMESTAMP`,
  ).bind(userRow.id, workspace.id).run();

  let board = await d1.prepare("SELECT id, name, description FROM fdp_boards WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
    .bind(workspace.id)
    .first<{ id: string; name: string; description: string }>();

  if (!board) {
    const boardId = crypto.randomUUID();
    const listIds = {
      new: crypto.randomUUID(),
      analysis: crypto.randomUUID(),
      waiting: crypto.randomUUID(),
      review: crypto.randomUUID(),
      done: crypto.randomUUID(),
    };
    const cardIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const ruleRows = [
      ["Ao atribuir um analista, mover para Em análise", "assignee.added", { assignee: "present" }, { moveTo: "analysis" }],
      ["Quando o SLA vencer, marcar como Atrasado", "sla.tick", { dueAt: "past" }, { slaStatus: "overdue" }],
      ["Ao concluir o checklist, mover para Concluído", "checklist.completed", { allItems: true }, { moveTo: "done" }],
      ["Ao aguardar documentos, pausar o SLA", "card.moved", { listKind: "waiting" }, { slaStatus: "paused" }],
      ["Ao sair da espera, retomar o SLA", "card.moved", { fromListKind: "waiting" }, { slaStatus: "recalculate" }],
    ] as const;

    await d1.batch([
      d1.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, 'Fila geral', 'Operação central do Departamento Pessoal', 'general')")
        .bind(boardId, workspace.id),
      d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Novas demandas', 'new', 1000, 'running')").bind(listIds.new, boardId),
      d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Em análise', 'analysis', 2000, 'running')").bind(listIds.analysis, boardId),
      d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Aguardando documentos', 'waiting', 3000, 'paused')").bind(listIds.waiting, boardId),
      d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Em conferência', 'review', 4000, 'running')").bind(listIds.review, boardId),
      d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Concluído', 'done', 5000, 'completed')").bind(listIds.done, boardId),
      d1.prepare(`INSERT INTO fdp_cards (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, 'Admissão — Maria Oliveira', 'Conferir documentos e preparar cadastro de admissão.', 'Synex Soluções', 'ADMISSÃO', 'urgent', 'Ana Martins', ?, 'warning', 1000, 'email', ?)`)
        .bind(cardIds[0], boardId, listIds.new, dateOffset(0), userRow.email),
      d1.prepare(`INSERT INTO fdp_cards (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, 'Inclusão no plano de saúde', 'Validar elegibilidade e documentação do dependente.', 'Matrícula 0482', 'BENEFÍCIOS', 'normal', 'Lucas Souza', ?, 'safe', 1000, 'manual', ?)`)
        .bind(cardIds[1], boardId, listIds.analysis, dateOffset(2), userRow.email),
      d1.prepare(`INSERT INTO fdp_cards (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, 'Documentos pendentes — Ana Reis', 'Aguardando comprovante e exame admissional.', 'Synex Soluções', 'ADMISSÃO', 'high', 'Rafael Costa', ?, 'paused', 1000, 'whatsapp', ?)`)
        .bind(cardIds[2], boardId, listIds.waiting, dateOffset(1), userRow.email),
      d1.prepare(`INSERT INTO fdp_cards (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, 'Conferência de cálculo rescisório', 'Revisar verbas e documentação antes do envio.', 'Empresa Sul', 'RESCISÃO', 'high', 'Ana Martins', ?, 'safe', 1000, 'teams', ?)`)
        .bind(cardIds[3], boardId, listIds.review, dateOffset(3), userRow.email),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Documentos pessoais recebidos', 1, 1000)").bind(crypto.randomUUID(), cardIds[0]),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Exame admissional anexado', 0, 2000)").bind(crypto.randomUUID(), cardIds[0]),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Cadastro no sistema concluído', 0, 3000)").bind(crypto.randomUUID(), cardIds[0]),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Elegibilidade validada', 1, 1000)").bind(crypto.randomUUID(), cardIds[1]),
      d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, 'Inclusão enviada à operadora', 0, 2000)").bind(crypto.randomUUID(), cardIds[1]),
      d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status, received_at) VALUES (?, ?, 'whatsapp', 'Mariana — Financeiro', 'Alteração de vale-transporte', 'Solicitação recebida pelo WhatsApp para a próxima competência.', 'new', datetime('now', '-18 minutes'))").bind(crypto.randomUUID(), workspace.id),
      d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status, received_at) VALUES (?, ?, 'email', 'Carlos Mendes', 'Programação de férias', 'Solicita programação para início no próximo mês.', 'new', datetime('now', '-2 hours'))").bind(crypto.randomUUID(), workspace.id),
      d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status, received_at) VALUES (?, ?, 'teams', 'Gestora Comercial', 'Nova admissão aprovada', 'Candidata aprovada; dados iniciais enviados no Teams.', 'new', datetime('now', '-1 day'))").bind(crypto.randomUUID(), workspace.id),
      ...ruleRows.map(([name, trigger, condition, action], index) =>
        d1.prepare("INSERT INTO fdp_automation_rules (id, workspace_id, name, trigger, condition_json, action_json, enabled, position) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
          .bind(crypto.randomUUID(), workspace!.id, name, trigger, JSON.stringify(condition), JSON.stringify(action), (index + 1) * 1000)),
    ]);
    board = { id: boardId, name: "Fila geral", description: "Operação central do Departamento Pessoal" };
  }

  return { d1, user: userRow, workspace, board };
}

export async function getWorkspaceSnapshot(user: ChatGPTUser): Promise<WorkspaceSnapshot> {
  const { d1, workspace, board, user: userRow } = await getWorkspaceContext(user);
  const today = new Date().toISOString().slice(0, 10);
  await d1.prepare(
    `UPDATE fdp_cards
     SET sla_status = CASE
       WHEN due_at < ? THEN 'overdue'
       WHEN due_at = ? THEN 'warning'
       ELSE 'safe'
     END,
     updated_at = CURRENT_TIMESTAMP
     WHERE board_id = ? AND archived = 0
       AND list_id IN (SELECT id FROM fdp_lists WHERE board_id = ? AND sla_behavior = 'running')
       AND due_at IS NOT NULL`,
  ).bind(today, today, board.id, board.id).run();

  const [listsResult, cardsResult, checklistResult, inboxResult, rulesResult, commentsResult, activitiesResult, membersResult, workspacesResult] = await Promise.all([
    d1.prepare("SELECT id, board_id, name, kind, position, sla_behavior FROM fdp_lists WHERE board_id = ? ORDER BY position").bind(board.id).all(),
    d1.prepare("SELECT * FROM fdp_cards WHERE board_id = ? AND archived = 0 ORDER BY list_id, position, created_at").bind(board.id).all(),
    d1.prepare("SELECT ci.* FROM fdp_checklist_items ci JOIN fdp_cards c ON c.id = ci.card_id WHERE c.board_id = ? AND c.archived = 0 ORDER BY ci.position").bind(board.id).all(),
    d1.prepare("SELECT id, channel, sender_name, subject, body, status, received_at, converted_card_id FROM fdp_workspace_inbox_items WHERE workspace_id = ? ORDER BY received_at DESC").bind(workspace.id).all(),
    d1.prepare("SELECT id, name, trigger, condition_json, action_json, enabled, position FROM fdp_automation_rules WHERE workspace_id = ? ORDER BY position").bind(workspace.id).all(),
    d1.prepare(`SELECT cc.id, cc.card_id, cc.body, cc.created_at, u.name AS author_name, u.email AS author_email
      FROM fdp_card_comments cc
      JOIN fdp_users u ON u.id = cc.author_user_id
      JOIN fdp_cards c ON c.id = cc.card_id
      WHERE c.board_id = ? AND c.archived = 0
      ORDER BY cc.created_at`).bind(board.id).all(),
    d1.prepare(`SELECT ae.id, ae.card_id, ae.actor_email, ae.event_type, ae.payload_json, ae.created_at,
        COALESCE(u.name, ae.actor_email) AS actor_name
      FROM fdp_activity_events ae
      JOIN fdp_cards c ON c.id = ae.card_id
      LEFT JOIN fdp_users u ON u.email = ae.actor_email
      WHERE c.board_id = ? AND c.archived = 0
      ORDER BY ae.created_at DESC`).bind(board.id).all(),
    d1.prepare(`SELECT u.id AS user_id, u.email, u.name, wm.role, wm.joined_at,
        CASE WHEN w.owner_user_id = u.id THEN 1 ELSE 0 END AS is_owner
      FROM fdp_workspace_members wm
      JOIN fdp_users u ON u.id = wm.user_id
      JOIN fdp_workspaces w ON w.id = wm.workspace_id
      WHERE wm.workspace_id = ?
      ORDER BY is_owner DESC, u.name`).bind(workspace.id).all(),
    d1.prepare(`SELECT w.id, w.name, wm.role
      FROM fdp_workspace_members wm
      JOIN fdp_workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY w.name`).bind(userRow.id).all(),
  ]);

  const checklistRows = checklistResult.results as Array<Record<string, unknown>>;
  const commentRows = commentsResult.results as Array<Record<string, unknown>>;
  const activityRows = activitiesResult.results as Array<Record<string, unknown>>;
  const cardRows = cardsResult.results as Array<Record<string, unknown>>;
  const cards = cardRows.map((row) => ({
    id: String(row.id),
    boardId: String(row.board_id),
    listId: String(row.list_id),
    title: String(row.title),
    description: String(row.description ?? ""),
    company: String(row.company ?? ""),
    processType: String(row.process_type ?? "OUTROS"),
    priority: String(row.priority ?? "normal") as "low" | "normal" | "high" | "urgent",
    assigneeName: String(row.assignee_name ?? ""),
    dueAt: row.due_at ? String(row.due_at) : null,
    slaStatus: String(row.sla_status ?? "safe") as "safe" | "warning" | "overdue" | "paused" | "completed",
    position: Number(row.position),
    sourceType: String(row.source_type ?? "manual"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    checklist: checklistRows.filter((item) => item.card_id === row.id).map((item) => ({
      id: String(item.id),
      cardId: String(item.card_id),
      title: String(item.title),
      completed: Boolean(item.completed),
      position: Number(item.position),
      completedAt: item.completed_at ? String(item.completed_at) : null,
    })),
    comments: commentRows.filter((item) => item.card_id === row.id).map((item) => ({
      id: String(item.id),
      cardId: String(item.card_id),
      authorName: String(item.author_name),
      authorEmail: String(item.author_email),
      body: String(item.body),
      createdAt: String(item.created_at),
    })),
    activities: activityRows.filter((item) => item.card_id === row.id).map((item) => ({
      id: String(item.id),
      cardId: item.card_id ? String(item.card_id) : null,
      actorEmail: String(item.actor_email),
      actorName: String(item.actor_name),
      eventType: String(item.event_type),
      payload: safeJson(String(item.payload_json)),
      createdAt: String(item.created_at),
    })),
  }));

  return {
    workspace: { ...workspace, role: workspace.role },
    board,
    lists: (listsResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      boardId: String(row.board_id),
      name: String(row.name),
      kind: String(row.kind),
      position: Number(row.position),
      slaBehavior: String(row.sla_behavior) as "running" | "paused" | "completed",
      cards: cards.filter((card) => card.listId === row.id),
    })),
    inbox: (inboxResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      channel: String(row.channel),
      senderName: String(row.sender_name),
      subject: String(row.subject),
      body: String(row.body ?? ""),
      status: String(row.status),
      receivedAt: String(row.received_at),
      convertedCardId: row.converted_card_id ? String(row.converted_card_id) : null,
    })),
    rules: (rulesResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      trigger: String(row.trigger),
      condition: safeJson(String(row.condition_json)),
      action: safeJson(String(row.action_json)),
      enabled: Boolean(row.enabled),
      position: Number(row.position),
    })),
    members: (membersResult.results as Array<Record<string, unknown>>).map((row) => ({
      userId: String(row.user_id),
      email: String(row.email),
      name: String(row.name),
      role: String(row.role) as WorkspaceRole,
      joinedAt: String(row.joined_at),
      isOwner: Boolean(row.is_owner),
    })),
    availableWorkspaces: (workspacesResult.results as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      role: String(row.role) as WorkspaceRole,
    })),
  };
}

export function requireWorkspaceRole(role: WorkspaceRole, allowed: WorkspaceRole[]) {
  if (!allowed.includes(role)) {
    throw new Error("Você não tem permissão para realizar esta ação.");
  }
}

export async function recordActivity(workspaceId: string, cardId: string | null, actorEmail: string, eventType: string, payload: Record<string, unknown> = {}) {
  const d1 = getD1();
  await d1.prepare("INSERT INTO fdp_activity_events (id, workspace_id, card_id, actor_email, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), workspaceId, cardId, actorEmail, eventType, JSON.stringify(payload))
    .run();
}

