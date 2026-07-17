/** Cloudflare Worker entry point for Fila DP. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type Role = "admin" | "analyst";
type UserStatus = "active" | "inactive";
type DemandStatus = "available" | "in_progress" | "waiting" | "done";

type AppUser = {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  createdById: number | null;
  updatedAt: string;
  lastAccessAt: string | null;
};

type DemandLabel = { id: number; name: string; color: string; status: UserStatus };

type DemandRaw = {
  id: number;
  title: string;
  description: string;
  category: string;
  company: string;
  companyId: number | null;
  employee: string | null;
  requester: string;
  source: "E-mail" | "Teams" | "WhatsApp" | "Verbal";
  priority: "low" | "medium" | "high" | "urgent";
  dueDate: string;
  status: DemandStatus;
  assigneeEmail: string | null;
  assignee: string | null;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  updatedById: number | null;
  labelsJson: string;
  checklistTotal: number;
  checklistCompleted: number;
};

type DemandRow = Omit<DemandRaw, "labelsJson"> & { labels: DemandLabel[] };

const demandSelect = `
  SELECT d.id, d.title, d.description, d.category,
    COALESCE(c.trade_name, d.company) AS company, d.company_id AS companyId,
    d.employee, d.requester, d.source, d.priority, d.due_date AS dueDate,
    d.status, d.assignee_email AS assigneeEmail, d.assignee_name AS assignee,
    d.created_by_email AS createdByEmail, d.created_at AS createdAt,
    d.updated_at AS updatedAt, d.version, d.updated_by_id AS updatedById,
    COALESCE((
      SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color, 'status', l.status))
      FROM demand_labels dl JOIN labels l ON l.id = dl.label_id
      WHERE dl.demand_id = d.id
    ), '[]') AS labelsJson,
    (SELECT COUNT(*) FROM demand_checklists dc WHERE dc.demand_id = d.id) AS checklistTotal,
    (SELECT COUNT(*) FROM demand_checklists dc WHERE dc.demand_id = d.id AND dc.completed = 1) AS checklistCompleted
  FROM demands d
  LEFT JOIN companies c ON c.id = d.company_id`;

const userSelect = `
  SELECT id, email, display_name AS displayName, role, status,
    created_at AS createdAt, created_by_id AS createdById,
    updated_at AS updatedAt, last_access_at AS lastAccessAt
  FROM users`;

const categories = new Set(["Admissão", "Férias", "Rescisão", "Ponto", "Folha", "Benefícios", "Afastamento", "eSocial", "Atendimento", "Outros"]);
const sources = new Set(["E-mail", "Teams", "WhatsApp", "Verbal"]);
const priorities = new Set(["low", "medium", "high", "urgent"]);
const statuses = new Set<DemandStatus>(["available", "in_progress", "waiting", "done"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const colorPattern = /^#[0-9a-f]{6}$/i;

const editableFields = {
  priority: { column: "priority", label: "prioridade", structural: false },
  dueDate: { column: "due_date", label: "prazo", structural: false },
  description: { column: "description", label: "descrição", structural: false },
  category: { column: "category", label: "tipo", structural: true },
  source: { column: "source", label: "canal de origem", structural: true },
  employee: { column: "employee", label: "funcionário", structural: true },
  requester: { column: "requester", label: "solicitante", structural: true },
} as const;

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function safeName(request: Request) {
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  if (!encoded || request.headers.get("oai-authenticated-user-full-name-encoding") !== "percent-encoded-utf-8") return null;
  try { return decodeURIComponent(encoded); } catch { return null; }
}

function normalizeDemand(row: DemandRaw | null): DemandRow | null {
  if (!row) return null;
  const { labelsJson, ...demand } = row;
  let labels: DemandLabel[] = [];
  try { labels = JSON.parse(labelsJson || "[]") as DemandLabel[]; } catch { labels = []; }
  return { ...demand, checklistTotal: Number(row.checklistTotal), checklistCompleted: Number(row.checklistCompleted), labels };
}

async function ensureUser(request: Request, env: Env): Promise<AppUser> {
  const email = request.headers.get("oai-authenticated-user-email") ?? "rian@filadp.local";
  const authenticatedName = safeName(request);
  let user = await env.DB.prepare(`${userSelect} WHERE email = ? LIMIT 1`).bind(email).first<AppUser>();

  if (!user) {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>();
    if (Number(countRow?.total ?? 0) > 0) throw new Error("ACESSO_NAO_CADASTRADO: peça a um administrador para cadastrar seu e-mail.");
    const displayName = authenticatedName ?? (email === "rian@filadp.local" ? "Rian Oliveira" : email);
    await env.DB.prepare("INSERT INTO users (email, display_name, role, status, last_access_at, updated_at) VALUES (?, ?, 'admin', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
      .bind(email, displayName).run();
    user = await env.DB.prepare(`${userSelect} WHERE email = ? LIMIT 1`).bind(email).first<AppUser>();
  }

  if (!user) throw new Error("Não foi possível preparar o usuário.");
  if (user.status === "inactive") throw new Error("USUARIO_INATIVO: seu acesso está inativo.");
  await env.DB.prepare("UPDATE users SET last_access_at = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id).run();
  return { ...user, lastAccessAt: new Date().toISOString() };
}

function requireFullAccess(user: AppUser) {
  if (user.status !== "active") throw new Error("USUARIO_INATIVO: seu acesso está inativo.");
}

async function addDemandHistory(
  env: Env,
  demandId: number,
  action: string,
  details: string,
  user: AppUser,
  change?: { fieldChanged?: string; oldValue?: unknown; newValue?: unknown; justification?: string },
) {
  await env.DB.prepare(`
    INSERT INTO demand_history
      (demand_id, action, details, user_email, user_name, user_id, field_changed, old_value, new_value, justification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      demandId, action, details, user.email, user.displayName, user.id,
      change?.fieldChanged ?? null,
      change?.oldValue == null ? null : String(change.oldValue),
      change?.newValue == null ? null : String(change.newValue),
      change?.justification ?? null,
    ).run();
}

async function addUserHistory(env: Env, targetUserId: number, actor: AppUser, action: string, field?: string, oldValue?: unknown, newValue?: unknown) {
  await env.DB.prepare(`
    INSERT INTO user_history (target_user_id, actor_user_id, action, field_changed, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(
      targetUserId, actor.id, action, field ?? null,
      oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue),
    ).run();
}

async function getDemand(env: Env, id: number) {
  const row = await env.DB.prepare(`${demandSelect} WHERE d.id = ? LIMIT 1`).bind(id).first<DemandRaw>();
  return normalizeDemand(row);
}

function canEditDemand(user: AppUser, demand: DemandRow) {
  return user.status === "active" && Boolean(demand);
}

async function activeTeam(env: Env) {
  const result = await env.DB.prepare(`
    SELECT u.id, u.display_name AS name, u.email,
      (SELECT COUNT(*) FROM demands d WHERE d.assignee_email = u.email AND d.status <> 'done') AS activeCount
    FROM users u WHERE u.status = 'active' ORDER BY activeCount, u.display_name`).all();
  return result.results;
}

function channelSource(channel: string) {
  return channel === "email" ? "E-mail" : channel === "whatsapp" ? "WhatsApp" : "Verbal";
}

function addBusinessDays(days: number) {
  const date = new Date();
  let remaining = Math.max(1, days);
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    const weekday = date.getDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

async function createNotification(env: Env, data: { userId?: number | null; type: string; title: string; message: string; demandId?: number | null; inboxItemId?: number | null }) {
  await env.DB.prepare(`INSERT INTO notifications (user_id, type, title, message, demand_id, inbox_item_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(data.userId ?? null, data.type, data.title, data.message, data.demandId ?? null, data.inboxItemId ?? null).run();
}

async function createDemandRecord(env: Env, user: AppUser, payload: Record<string, unknown>) {
  const category = String(payload.category ?? "").trim();
  const companyId = Number(payload.companyId);
  const company = await activeCompany(env, companyId);
  const employee = String(payload.employee ?? "").trim();
  const requester = String(payload.requester ?? "").trim();
  const source = String(payload.source ?? "");
  const rule = await env.DB.prepare("SELECT business_days AS businessDays, default_priority AS defaultPriority FROM sla_rules WHERE category = ? AND status = 'active'")
    .bind(category).first<{ businessDays: number; defaultPriority: string }>();
  const priority = String(payload.priority ?? rule?.defaultPriority ?? "medium");
  const dueDate = String(payload.dueDate ?? (rule ? addBusinessDays(Number(rule.businessDays)) : ""));
  const description = String(payload.description ?? "").trim();
  const labelIds = Array.isArray(payload.labelIds) ? payload.labelIds.map(Number).filter(Number.isInteger) : [];
  if (!categories.has(category) || !company || !requester || !sources.has(source) || !priorities.has(priority) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new Error("Revise os campos obrigatórios da demanda.");
  }
  const title = `${category} – ${employee || company.tradeName}`;
  const insert = await env.DB.prepare(`
    INSERT INTO demands (title, description, category, company, company_id, employee, requester, source, priority, due_date, created_by_email, updated_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(
      title, description, category, company.tradeName, company.id, employee || null, requester, source, priority, dueDate, user.email, user.id,
    ).first<{ id: number }>();
  if (!insert) throw new Error("Não foi possível cadastrar a demanda.");
  const templates = await env.DB.prepare(`SELECT item_text AS text, sort_order AS sortOrder FROM checklist_templates WHERE category = ? AND status = 'active' ORDER BY sort_order, id`)
    .bind(category).all<{ text: string; sortOrder: number }>();
  for (const item of templates.results) await env.DB.prepare("INSERT INTO demand_checklists (demand_id, item_text, sort_order) VALUES (?, ?, ?)").bind(insert.id, item.text, item.sortOrder).run();
  for (const labelId of labelIds) await env.DB.prepare(`INSERT OR IGNORE INTO demand_labels (demand_id, label_id, assigned_by_id) SELECT ?, id, ? FROM labels WHERE id = ? AND status = 'active'`).bind(insert.id, user.id, labelId).run();
  await addDemandHistory(env, insert.id, "created", `Demanda cadastrada via ${source}`, user);
  if (templates.results.length) await addDemandHistory(env, insert.id, "checklist_created", `${templates.results.length} itens automáticos adicionados`, user);
  return getDemand(env, insert.id);
}

async function activeCompany(env: Env, id: number) {
  return env.DB.prepare("SELECT id, legal_name AS legalName, trade_name AS tradeName, cnpj, status FROM companies WHERE id = ? AND status = 'active' LIMIT 1")
    .bind(id).first<{ id: number; legalName: string; tradeName: string; cnpj: string | null; status: UserStatus }>();
}

async function loadChecklist(env: Env, demandId: number) {
  const result = await env.DB.prepare(`
    SELECT dc.id, dc.item_text AS text, dc.completed, dc.completed_at AS completedAt,
      dc.sort_order AS sortOrder, u.display_name AS completedBy
    FROM demand_checklists dc LEFT JOIN users u ON u.id = dc.completed_by_id
    WHERE dc.demand_id = ? ORDER BY dc.sort_order, dc.id`).bind(demandId).all();
  return result.results;
}

async function handleDemandCollaboration(request: Request, env: Env, url: URL): Promise<Response | null> {
  const timelineMatch = url.pathname.match(/^\/api\/demands\/(\d+)\/timeline$/);
  if (timelineMatch) {
    const user = await ensureUser(request, env);
    const demandId = Number(timelineMatch[1]);
    if (!await getDemand(env, demandId)) return json({ error: "Demanda não encontrada." }, 404);
    if (request.method === "GET") {
      const [history, comments] = await Promise.all([
        env.DB.prepare(`
          SELECT id, 'system' AS eventType, action, details, user_name AS userName,
            field_changed AS fieldChanged, old_value AS oldValue, new_value AS newValue,
            justification, created_at AS createdAt
          FROM demand_history WHERE demand_id = ?`).bind(demandId).all<Record<string, unknown>>(),
        env.DB.prepare(`
          SELECT c.id, 'comment' AS eventType, c.text, u.display_name AS userName,
            u.email AS userEmail, c.created_at AS createdAt, c.updated_at AS updatedAt
          FROM demand_comments c JOIN users u ON u.id = c.user_id
          WHERE c.demand_id = ?`).bind(demandId).all<Record<string, unknown>>(),
      ]);
      const timeline = [...history.results, ...comments.results].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json({ timeline });
    }
    if (request.method === "POST") {
      const payload = await request.json<{ text?: string }>();
      const text = payload.text?.trim() ?? "";
      if (!text || text.length > 2000) return json({ error: "O comentário deve ter entre 1 e 2.000 caracteres." }, 400);
      const created = await env.DB.prepare("INSERT INTO demand_comments (demand_id, user_id, text) VALUES (?, ?, ?) RETURNING id")
        .bind(demandId, user.id, text).first<{ id: number }>();
      await env.DB.prepare("UPDATE demands SET updated_at = CURRENT_TIMESTAMP, updated_by_id = ?, version = version + 1 WHERE id = ?")
        .bind(user.id, demandId).run();
      await createNotification(env, { type: "comment", title: "Novo comentário em demanda", message: `${user.displayName}: ${text.slice(0, 120)}`, demandId });
      return json({ id: created?.id, demand: await getDemand(env, demandId) }, 201);
    }
    return null;
  }

  const checklistItemMatch = url.pathname.match(/^\/api\/demands\/(\d+)\/checklist\/(\d+)$/);
  if (checklistItemMatch && request.method === "PATCH") {
    const user = await ensureUser(request, env);
    const demandId = Number(checklistItemMatch[1]);
    const itemId = Number(checklistItemMatch[2]);
    const demand = await getDemand(env, demandId);
    if (!demand) return json({ error: "Demanda não encontrada." }, 404);
    if (!canEditDemand(user, demand)) return json({ error: "Você não pode alterar este checklist." }, 403);
    const item = await env.DB.prepare("SELECT id, item_text AS text, completed FROM demand_checklists WHERE id = ? AND demand_id = ?")
      .bind(itemId, demandId).first<{ id: number; text: string; completed: number }>();
    if (!item) return json({ error: "Item de checklist não encontrado." }, 404);
    const payload = await request.json<{ completed?: boolean }>();
    const completed = Boolean(payload.completed);
    await env.DB.prepare(`
      UPDATE demand_checklists SET completed = ?, completed_by_id = ?, completed_at = ?
      WHERE id = ? AND demand_id = ?`).bind(
        completed ? 1 : 0, completed ? user.id : null, completed ? new Date().toISOString() : null, itemId, demandId,
      ).run();
    await env.DB.prepare("UPDATE demands SET updated_at = CURRENT_TIMESTAMP, updated_by_id = ?, version = version + 1 WHERE id = ?")
      .bind(user.id, demandId).run();
    await addDemandHistory(env, demandId, "checklist_updated", completed ? `Checklist concluído: ${item.text}` : `Checklist reaberto: ${item.text}`, user, {
      fieldChanged: "checklist", oldValue: item.completed ? "concluído" : "pendente", newValue: completed ? "concluído" : "pendente",
    });
    return json({ checklist: await loadChecklist(env, demandId), demand: await getDemand(env, demandId) });
  }

  const checklistMatch = url.pathname.match(/^\/api\/demands\/(\d+)\/checklist$/);
  if (checklistMatch) {
    const user = await ensureUser(request, env);
    const demandId = Number(checklistMatch[1]);
    const demand = await getDemand(env, demandId);
    if (!demand) return json({ error: "Demanda não encontrada." }, 404);
    if (request.method === "GET") return json({ checklist: await loadChecklist(env, demandId), canEdit: canEditDemand(user, demand) });
    if (request.method === "POST") {
      if (!canEditDemand(user, demand)) return json({ error: "Você não pode alterar este checklist." }, 403);
      const payload = await request.json<{ text?: string }>();
      const text = payload.text?.trim() ?? "";
      if (!text || text.length > 240) return json({ error: "Informe um item com até 240 caracteres." }, 400);
      const order = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM demand_checklists WHERE demand_id = ?")
        .bind(demandId).first<{ nextOrder: number }>();
      await env.DB.prepare("INSERT INTO demand_checklists (demand_id, item_text, sort_order) VALUES (?, ?, ?)")
        .bind(demandId, text, Number(order?.nextOrder ?? 1)).run();
      await env.DB.prepare("UPDATE demands SET updated_at = CURRENT_TIMESTAMP, updated_by_id = ?, version = version + 1 WHERE id = ?")
        .bind(user.id, demandId).run();
      await addDemandHistory(env, demandId, "checklist_added", `Item adicionado ao checklist: ${text}`, user);
      return json({ checklist: await loadChecklist(env, demandId), demand: await getDemand(env, demandId) }, 201);
    }
  }
  return null;
}

async function handleDemands(request: Request, env: Env, url: URL): Promise<Response | null> {
  const collaboration = await handleDemandCollaboration(request, env, url);
  if (collaboration) return collaboration;

  if (url.pathname === "/api/demands" && request.method === "GET") {
    const user = await ensureUser(request, env);
    const result = await env.DB.prepare(`${demandSelect} ORDER BY d.created_at DESC, d.id DESC`).all<DemandRaw>();
    return json({
      demands: result.results.map((row) => normalizeDemand(row)),
      user: { name: user.displayName, email: user.email, role: user.role },
      team: await activeTeam(env),
    });
  }

  if (url.pathname === "/api/demands" && request.method === "POST") {
    const user = await ensureUser(request, env);
    const payload = await request.json<Record<string, unknown>>();
    try {
      return json({ demand: await createDemandRecord(env, user, payload) }, 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Não foi possível cadastrar a demanda." }, 400);
    }
  }

  const historyMatch = url.pathname.match(/^\/api\/demands\/(\d+)\/history$/);
  if (historyMatch && request.method === "GET") {
    await ensureUser(request, env);
    const result = await env.DB.prepare(`
      SELECT id, action, details, user_name AS userName, field_changed AS fieldChanged,
        old_value AS oldValue, new_value AS newValue, justification, created_at AS createdAt
      FROM demand_history WHERE demand_id = ? ORDER BY created_at DESC, id DESC`).bind(Number(historyMatch[1])).all();
    return json({ history: result.results });
  }

  const match = url.pathname.match(/^\/api\/demands\/(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  const user = await ensureUser(request, env);
  const existing = await getDemand(env, id);
  if (!existing) return json({ error: "Demanda não encontrada." }, 404);

  if (request.method === "GET") {
    return json({ demand: existing, canEdit: canEditDemand(user, existing), editableStructuralFields: true });
  }

  if (request.method === "PUT") {
    const payload = await request.json<Record<string, unknown>>();
    const receivedVersion = Number(payload.version);
    if (receivedVersion !== existing.version) return json({ error: "CONFLITO_VERSAO", message: "Esta demanda foi alterada por outro usuário. Recarregue os dados antes de editar.", currentVersion: existing.version }, 409);
    if (!canEditDemand(user, existing)) return json({ error: "Você não tem permissão para editar esta demanda." }, 403);
    const justification = String(payload.justification ?? "").trim();
    if (existing.status === "done" && !justification) return json({ error: "JUSTIFICATIVA_OBRIGATORIA", message: "É necessário informar o motivo para editar uma demanda concluída." }, 422);

    const changes: Array<{ key: string; column: string; label: string; oldValue: unknown; newValue: unknown; historyOld?: unknown; historyNew?: unknown }> = [];
    for (const key of Object.keys(editableFields) as Array<keyof typeof editableFields>) {
      if (!(key in payload)) continue;
      const config = editableFields[key];
      const newValue = key === "employee" ? (String(payload[key] ?? "").trim() || null) : String(payload[key] ?? "").trim();
      const oldValue = existing[key];
      if (String(oldValue ?? "") !== String(newValue ?? "")) changes.push({ key, column: config.column, label: config.label, oldValue, newValue });
    }

    let selectedCompany: Awaited<ReturnType<typeof activeCompany>> | null = null;
    if ("companyId" in payload) {
      const companyId = Number(payload.companyId);
      selectedCompany = await activeCompany(env, companyId);
      if (!selectedCompany) return json({ error: "Selecione uma empresa ativa." }, 400);
      if (companyId !== existing.companyId) changes.push({ key: "companyId", column: "company_id", label: "empresa", oldValue: existing.companyId, newValue: companyId, historyOld: existing.company, historyNew: selectedCompany.tradeName });
    }

    if (!changes.length) return json({ demand: existing, changedFields: [] });
    const nextValues = Object.fromEntries(changes.map((change) => [change.key, change.newValue])) as Record<string, unknown>;
    if (nextValues.category && !categories.has(String(nextValues.category))) return json({ error: "Tipo de demanda inválido." }, 400);
    if (nextValues.source && !sources.has(String(nextValues.source))) return json({ error: "Canal de origem inválido." }, 400);
    if (nextValues.priority && !priorities.has(String(nextValues.priority))) return json({ error: "Prioridade inválida." }, 400);
    if (nextValues.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(nextValues.dueDate))) return json({ error: "Prazo inválido." }, 400);

    const finalCategory = String(nextValues.category ?? existing.category);
    const finalCompany = selectedCompany?.tradeName ?? existing.company;
    const finalEmployee = nextValues.employee !== undefined ? nextValues.employee : existing.employee;
    const title = `${finalCategory} – ${finalEmployee || finalCompany}`;
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const change of changes) {
      assignments.push(`${change.column} = ?`); values.push(change.newValue);
      if (change.key === "companyId") { assignments.push("company = ?"); values.push(finalCompany); }
    }
    assignments.push("title = ?", "version = version + 1", "updated_at = CURRENT_TIMESTAMP", "updated_by_id = ?");
    values.push(title, user.id, id, existing.version);
    const updated = await env.DB.prepare(`UPDATE demands SET ${assignments.join(", ")} WHERE id = ? AND version = ? RETURNING id`)
      .bind(...values).first<{ id: number }>();
    if (!updated) return json({ error: "CONFLITO_VERSAO", message: "Esta demanda foi alterada por outro usuário. Recarregue os dados antes de editar." }, 409);
    for (const change of changes) {
      await addDemandHistory(env, id, "edited", `${change.label} alterado`, user, {
        fieldChanged: change.label,
        oldValue: change.historyOld ?? change.oldValue,
        newValue: change.historyNew ?? change.newValue,
        justification: justification || undefined,
      });
    }
    return json({ demand: await getDemand(env, id), changedFields: changes.map((change) => change.key) });
  }

  if (request.method !== "PATCH") return null;
  const payload = await request.json<Record<string, unknown>>();

  if (payload.action === "claim") {
    const updated = await env.DB.prepare(`
      UPDATE demands SET status = 'in_progress', assignee_email = ?, assignee_name = ?,
        updated_at = CURRENT_TIMESTAMP, updated_by_id = ?, version = version + 1
      WHERE id = ? AND assignee_email IS NULL AND status = 'available' RETURNING id`).bind(
        user.email, user.displayName, user.id, id,
      ).first<{ id: number }>();
    if (!updated) return json({ error: "Outro analista assumiu esta demanda primeiro." }, 409);
    await addDemandHistory(env, id, "claimed", "Demanda assumida", user);
    await createNotification(env, { userId: user.id, type: "assigned", title: "Demanda atribuída a você", message: existing.title, demandId: id });
    return json({ demand: await getDemand(env, id) });
  }

  if (payload.action === "quick_update") {
    const receivedVersion = Number(payload.version);
    if (receivedVersion !== existing.version) return json({ error: "CONFLITO_VERSAO", message: "O cartão mudou enquanto você editava. Os dados foram recarregados." }, 409);
    if (!canEditDemand(user, existing)) return json({ error: "Você não tem permissão para editar este cartão." }, 403);
    if (existing.status === "done") return json({ error: "Abra a demanda e informe uma justificativa para editar itens concluídos." }, 422);

    const assignments: string[] = [];
    const values: unknown[] = [];
    const history: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    if ("dueDate" in payload) {
      const dueDate = String(payload.dueDate ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return json({ error: "Prazo inválido." }, 400);
      if (dueDate !== existing.dueDate) { assignments.push("due_date = ?"); values.push(dueDate); history.push({ field: "prazo", oldValue: existing.dueDate, newValue: dueDate }); }
    }

    if ("assigneeEmail" in payload) {
      requireFullAccess(user);
      const email = String(payload.assigneeEmail ?? "").trim();
      const assignee = email ? await env.DB.prepare("SELECT id, email, display_name AS name FROM users WHERE email = ? AND status = 'active' LIMIT 1").bind(email).first<{ id: number; email: string; name: string }>() : null;
      if (email && !assignee) return json({ error: "Responsável inválido ou inativo." }, 400);
      assignments.push("assignee_email = ?", "assignee_name = ?", "status = ?");
      values.push(assignee?.email ?? null, assignee?.name ?? null, assignee ? (existing.status === "available" ? "in_progress" : existing.status) : "available");
      history.push({ field: "responsável", oldValue: existing.assignee ?? "Sem responsável", newValue: assignee?.name ?? "Sem responsável" });
    }

    let labelIds: number[] | null = null;
    if (Array.isArray(payload.labelIds)) {
      labelIds = [...new Set(payload.labelIds.map(Number).filter(Number.isInteger))];
      if (labelIds.length) {
        const placeholders = labelIds.map(() => "?").join(",");
        const valid = await env.DB.prepare(`SELECT id FROM labels WHERE status = 'active' AND id IN (${placeholders})`).bind(...labelIds).all<{ id: number }>();
        if (valid.results.length !== labelIds.length) return json({ error: "Uma das etiquetas selecionadas está inativa." }, 400);
      }
      const currentIds = existing.labels.map((label) => label.id).sort((a, b) => a - b);
      const nextIds = [...labelIds].sort((a, b) => a - b);
      if (currentIds.join(",") === nextIds.join(",")) labelIds = null;
      else history.push({ field: "etiquetas", oldValue: existing.labels.map((label) => label.name).join(", ") || "Nenhuma", newValue: "Atualizadas" });
    }

    if (!assignments.length && labelIds === null) return json({ demand: existing });
    assignments.push("version = version + 1", "updated_at = CURRENT_TIMESTAMP", "updated_by_id = ?");
    values.push(user.id, id, existing.version);
    const updated = await env.DB.prepare(`UPDATE demands SET ${assignments.join(", ")} WHERE id = ? AND version = ? RETURNING id`)
      .bind(...values).first<{ id: number }>();
    if (!updated) return json({ error: "CONFLITO_VERSAO", message: "O cartão mudou enquanto você editava. Os dados foram recarregados." }, 409);
    if (labelIds !== null) {
      await env.DB.prepare("DELETE FROM demand_labels WHERE demand_id = ?").bind(id).run();
      for (const labelId of labelIds) await env.DB.prepare("INSERT INTO demand_labels (demand_id, label_id, assigned_by_id) VALUES (?, ?, ?)").bind(id, labelId, user.id).run();
    }
    const updatedDemand = await getDemand(env, id);
    const labelHistory = history.find((item) => item.field === "etiquetas");
    if (labelHistory && updatedDemand) labelHistory.newValue = updatedDemand.labels.map((label) => label.name).join(", ") || "Nenhuma";
    for (const item of history) await addDemandHistory(env, id, "edited", `${item.field} alterado`, user, { fieldChanged: item.field, oldValue: item.oldValue, newValue: item.newValue });
    if ("assigneeEmail" in payload) {
      const assignedEmail = String(payload.assigneeEmail ?? "");
      if (assignedEmail) {
        const assignedUser = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").bind(assignedEmail).first<{ id: number }>();
        if (assignedUser) await createNotification(env, { userId: assignedUser.id, type: "assigned", title: "Demanda atribuída a você", message: existing.title, demandId: id });
      }
    }
    return json({ demand: updatedDemand });
  }

  if (payload.action === "move" && payload.status && statuses.has(payload.status as DemandStatus)) {
    const status = payload.status as DemandStatus;
    const justification = String(payload.justification ?? "").trim();
    if (existing.status === "done" && status !== "done") {
      if (!justification) return json({ error: "JUSTIFICATIVA_OBRIGATORIA", message: "Informe o motivo para reabrir a demanda." }, 422);
    }
    const assigneeEmail = status === "available" ? null : (existing.assigneeEmail ?? user.email);
    const assigneeName = status === "available" ? null : (existing.assignee ?? user.displayName);
    await env.DB.prepare(`
      UPDATE demands SET status = ?, assignee_email = ?, assignee_name = ?, updated_at = CURRENT_TIMESTAMP,
        updated_by_id = ?, version = version + 1 WHERE id = ?`).bind(status, assigneeEmail, assigneeName, user.id, id).run();
    const action = existing.status === "done" && status !== "done" ? "reopened" : status === "available" ? "returned" : "status_changed";
    await addDemandHistory(env, id, action, `Status alterado de ${existing.status} para ${status}`, user, {
      fieldChanged: "status", oldValue: existing.status, newValue: status, justification: justification || undefined,
    });
    if (status === "done") await createNotification(env, { type: "completed", title: "Demanda concluída", message: existing.title, demandId: id });
    return json({ demand: await getDemand(env, id) });
  }
  return json({ error: "Ação inválida." }, 400);
}

async function handleCompanies(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/companies")) return null;
  const user = await ensureUser(request, env);
  if (url.pathname === "/api/companies" && request.method === "GET") {
    const all = url.searchParams.get("status") === "all";
    const result = await env.DB.prepare(`
      SELECT c.id, c.legal_name AS legalName, c.trade_name AS tradeName, c.cnpj, c.status,
        c.created_at AS createdAt, c.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM demands d WHERE d.company_id = c.id) AS demandCount
      FROM companies c ${all ? "" : "WHERE c.status = 'active'"} ORDER BY c.trade_name`).all();
    return json({ companies: result.results });
  }
  if (url.pathname === "/api/companies" && request.method === "POST") {
    requireFullAccess(user);
    const payload = await request.json<{ legalName?: string; tradeName?: string; cnpj?: string }>();
    const legalName = payload.legalName?.trim() ?? "";
    const tradeName = payload.tradeName?.trim() ?? "";
    const cnpj = payload.cnpj?.replace(/\D/g, "") || null;
    if (legalName.length < 2 || tradeName.length < 2 || (cnpj && cnpj.length !== 14)) return json({ error: "Revise razão social, nome fantasia e CNPJ." }, 400);
    try {
      const created = await env.DB.prepare("INSERT INTO companies (legal_name, trade_name, cnpj) VALUES (?, ?, ?) RETURNING id")
        .bind(legalName, tradeName, cnpj).first<{ id: number }>();
      const company = await env.DB.prepare("SELECT id, legal_name AS legalName, trade_name AS tradeName, cnpj, status, created_at AS createdAt, updated_at AS updatedAt FROM companies WHERE id = ?")
        .bind(created?.id).first();
      return json({ company }, 201);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return json({ error: "Já existe uma empresa com este nome fantasia ou CNPJ." }, 409);
      throw error;
    }
  }
  const match = url.pathname.match(/^\/api\/companies\/(\d+)$/);
  if (!match || request.method !== "PUT") return null;
  requireFullAccess(user);
  const id = Number(match[1]);
  const existing = await env.DB.prepare("SELECT id, legal_name AS legalName, trade_name AS tradeName, cnpj, status FROM companies WHERE id = ?")
    .bind(id).first<{ id: number; legalName: string; tradeName: string; cnpj: string | null; status: UserStatus }>();
  if (!existing) return json({ error: "Empresa não encontrada." }, 404);
  const payload = await request.json<{ legalName?: string; tradeName?: string; cnpj?: string; status?: UserStatus }>();
  const legalName = payload.legalName?.trim() ?? existing.legalName;
  const tradeName = payload.tradeName?.trim() ?? existing.tradeName;
  const cnpj = payload.cnpj === undefined ? existing.cnpj : (payload.cnpj.replace(/\D/g, "") || null);
  const status = payload.status ?? existing.status;
  if (legalName.length < 2 || tradeName.length < 2 || (cnpj && cnpj.length !== 14) || !["active", "inactive"].includes(status)) return json({ error: "Dados da empresa inválidos." }, 400);
  try {
    await env.DB.prepare("UPDATE companies SET legal_name = ?, trade_name = ?, cnpj = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(legalName, tradeName, cnpj, status, id).run();
    await env.DB.prepare("UPDATE demands SET company = ?, updated_at = CURRENT_TIMESTAMP WHERE company_id = ?").bind(tradeName, id).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ error: "Já existe uma empresa com este nome fantasia ou CNPJ." }, 409);
    throw error;
  }
  const company = await env.DB.prepare("SELECT id, legal_name AS legalName, trade_name AS tradeName, cnpj, status, created_at AS createdAt, updated_at AS updatedAt FROM companies WHERE id = ?")
    .bind(id).first();
  return json({ company });
}

async function handleLabels(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/labels")) return null;
  const user = await ensureUser(request, env);
  if (url.pathname === "/api/labels" && request.method === "GET") {
    const all = url.searchParams.get("status") === "all";
    const result = await env.DB.prepare(`SELECT id, name, color, status, created_at AS createdAt, updated_at AS updatedAt FROM labels ${all ? "" : "WHERE status = 'active'"} ORDER BY name`).all();
    return json({ labels: result.results });
  }
  if (url.pathname === "/api/labels" && request.method === "POST") {
    requireFullAccess(user);
    const payload = await request.json<{ name?: string; color?: string }>();
    const name = payload.name?.trim() ?? "";
    const color = payload.color?.trim() ?? "";
    if (name.length < 2 || !colorPattern.test(color)) return json({ error: "Informe um nome e uma cor válida." }, 400);
    try {
      const created = await env.DB.prepare("INSERT INTO labels (name, color) VALUES (?, ?) RETURNING id").bind(name, color).first<{ id: number }>();
      const label = await env.DB.prepare("SELECT id, name, color, status FROM labels WHERE id = ?").bind(created?.id).first();
      return json({ label }, 201);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return json({ error: "Já existe uma etiqueta com este nome." }, 409);
      throw error;
    }
  }
  const match = url.pathname.match(/^\/api\/labels\/(\d+)$/);
  if (!match || request.method !== "PUT") return null;
  requireFullAccess(user);
  const id = Number(match[1]);
  const existing = await env.DB.prepare("SELECT id, name, color, status FROM labels WHERE id = ?").bind(id).first<{ id: number; name: string; color: string; status: UserStatus }>();
  if (!existing) return json({ error: "Etiqueta não encontrada." }, 404);
  const payload = await request.json<{ name?: string; color?: string; status?: UserStatus }>();
  const name = payload.name?.trim() ?? existing.name;
  const color = payload.color?.trim() ?? existing.color;
  const status = payload.status ?? existing.status;
  if (name.length < 2 || !colorPattern.test(color) || !["active", "inactive"].includes(status)) return json({ error: "Dados da etiqueta inválidos." }, 400);
  await env.DB.prepare("UPDATE labels SET name = ?, color = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(name, color, status, id).run();
  return json({ label: await env.DB.prepare("SELECT id, name, color, status FROM labels WHERE id = ?").bind(id).first() });
}

async function handleTemplates(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/checklist-templates")) return null;
  const user = await ensureUser(request, env);
  if (url.pathname === "/api/checklist-templates" && request.method === "GET") {
    const all = url.searchParams.get("status") === "all";
    const result = await env.DB.prepare(`SELECT id, category, item_text AS text, sort_order AS sortOrder, status FROM checklist_templates ${all ? "" : "WHERE status = 'active'"} ORDER BY category, sort_order, id`).all();
    return json({ templates: result.results });
  }
  if (url.pathname === "/api/checklist-templates" && request.method === "POST") {
    requireFullAccess(user);
    const payload = await request.json<{ category?: string; text?: string }>();
    const category = payload.category?.trim() ?? "";
    const text = payload.text?.trim() ?? "";
    if (!categories.has(category) || !text || text.length > 240) return json({ error: "Selecione o tipo e informe um item válido." }, 400);
    const order = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM checklist_templates WHERE category = ?").bind(category).first<{ nextOrder: number }>();
    try {
      const created = await env.DB.prepare("INSERT INTO checklist_templates (category, item_text, sort_order) VALUES (?, ?, ?) RETURNING id")
        .bind(category, text, Number(order?.nextOrder ?? 1)).first<{ id: number }>();
      return json({ template: await env.DB.prepare("SELECT id, category, item_text AS text, sort_order AS sortOrder, status FROM checklist_templates WHERE id = ?").bind(created?.id).first() }, 201);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return json({ error: "Este item já existe no modelo." }, 409);
      throw error;
    }
  }
  const match = url.pathname.match(/^\/api\/checklist-templates\/(\d+)$/);
  if (!match || request.method !== "PUT") return null;
  requireFullAccess(user);
  const id = Number(match[1]);
  const existing = await env.DB.prepare("SELECT id, category, item_text AS text, sort_order AS sortOrder, status FROM checklist_templates WHERE id = ?")
    .bind(id).first<{ id: number; category: string; text: string; sortOrder: number; status: UserStatus }>();
  if (!existing) return json({ error: "Modelo não encontrado." }, 404);
  const payload = await request.json<{ text?: string; status?: UserStatus }>();
  const text = payload.text?.trim() ?? existing.text;
  const status = payload.status ?? existing.status;
  if (!text || text.length > 240 || !["active", "inactive"].includes(status)) return json({ error: "Dados do modelo inválidos." }, 400);
  await env.DB.prepare("UPDATE checklist_templates SET item_text = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(text, status, id).run();
  return json({ template: await env.DB.prepare("SELECT id, category, item_text AS text, sort_order AS sortOrder, status FROM checklist_templates WHERE id = ?").bind(id).first() });
}

async function activeDemandCount(env: Env, email: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM demands WHERE assignee_email = ? AND status IN ('in_progress', 'waiting')")
    .bind(email).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function handleUsers(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/users")) return null;
  if (url.pathname === "/api/users" && request.method === "GET") {
    const currentUser = await ensureUser(request, env);
    requireFullAccess(currentUser);
    const search = url.searchParams.get("search")?.trim() ?? "";
    const role = url.searchParams.get("role") ?? "all";
    const status = url.searchParams.get("status") ?? "all";
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (search) { clauses.push("(display_name LIKE ? OR email LIKE ?)"); bindings.push(`%${search}%`, `%${search}%`); }
    if (["admin", "analyst"].includes(role)) { clauses.push("role = ?"); bindings.push(role); }
    if (["active", "inactive"].includes(status)) { clauses.push("status = ?"); bindings.push(status); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const result = await env.DB.prepare(`${userSelect}${where} ORDER BY display_name ASC`).bind(...bindings).all<AppUser>();
    return json({ users: result.results, currentUser });
  }

  if (url.pathname === "/api/users" && request.method === "POST") {
    const actor = await ensureUser(request, env);
    requireFullAccess(actor);
    const payload = await request.json<{ name?: string; email?: string; role?: string }>();
    const name = payload.name?.trim() ?? "";
    const email = payload.email?.trim().toLowerCase() ?? "";
    const role = payload.role ?? "analyst";
    if (name.length < 3 || !emailPattern.test(email) || !["admin", "analyst"].includes(role)) return json({ error: "Revise nome, e-mail e perfil." }, 400);
    const duplicate = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first<{ id: number }>();
    if (duplicate) return json({ error: "Este e-mail já está cadastrado." }, 409);
    const created = await env.DB.prepare(`
      INSERT INTO users (display_name, email, role, status, created_by_id, updated_at)
      VALUES (?, ?, ?, 'active', ?, CURRENT_TIMESTAMP) RETURNING id`).bind(name, email, role, actor.id).first<{ id: number }>();
    if (!created) throw new Error("Não foi possível criar o usuário.");
    await addUserHistory(env, created.id, actor, "created");
    const user = await env.DB.prepare(`${userSelect} WHERE id = ?`).bind(created.id).first<AppUser>();
    return json({ user, accessMessage: "O usuário acessará com a conta ChatGPT vinculada a este e-mail." }, 201);
  }

  const historyMatch = url.pathname.match(/^\/api\/users\/(\d+)\/history$/);
  if (historyMatch && request.method === "GET") {
    const actor = await ensureUser(request, env);
    requireFullAccess(actor);
    const result = await env.DB.prepare(`
      SELECT h.id, h.action, h.field_changed AS fieldChanged, h.old_value AS oldValue,
        h.new_value AS newValue, h.created_at AS createdAt, u.display_name AS actorName
      FROM user_history h JOIN users u ON u.id = h.actor_user_id
      WHERE h.target_user_id = ? ORDER BY h.created_at DESC, h.id DESC`).bind(Number(historyMatch[1])).all();
    return json({ history: result.results });
  }

  const statusMatch = url.pathname.match(/^\/api\/users\/(\d+)\/status$/);
  const match = url.pathname.match(/^\/api\/users\/(\d+)$/);
  if (!statusMatch && !match) return null;
  const id = Number((statusMatch ?? match)![1]);
  const actor = await ensureUser(request, env);
  requireFullAccess(actor);
  const existing = await env.DB.prepare(`${userSelect} WHERE id = ? LIMIT 1`).bind(id).first<AppUser>();
  if (!existing) return json({ error: "Usuário não encontrado." }, 404);
  if (request.method === "GET") return json({ user: existing, activeDemandCount: await activeDemandCount(env, existing.email) });
  if (request.method !== "PUT" && request.method !== "PATCH") return null;

  const payload = await request.json<{ name?: string; email?: string; role?: string; status?: string; confirmInactive?: boolean }>();
  const name = payload.name?.trim() ?? existing.displayName;
  const email = payload.email?.trim().toLowerCase() ?? existing.email;
  const role = (payload.role ?? existing.role) as Role;
  const status = (payload.status ?? existing.status) as UserStatus;
  if (name.length < 3 || !emailPattern.test(email) || !["admin", "analyst"].includes(role) || !["active", "inactive"].includes(status)) return json({ error: "Dados do usuário inválidos." }, 400);
  if (id === actor.id && (role !== existing.role || status !== "active")) return json({ error: "AUTOEDICAO_PERFIL_BLOQUEADA", message: "Você não pode alterar seu próprio perfil de administrador nem inativar seu acesso." }, 422);
  const duplicate = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1").bind(email, id).first<{ id: number }>();
  if (duplicate) return json({ error: "Este e-mail já está cadastrado." }, 409);
  const activeCount = status === "inactive" && existing.status !== "inactive" ? await activeDemandCount(env, existing.email) : 0;
  if (activeCount > 0 && !payload.confirmInactive) return json({ error: "ACTIVE_DEMANDS", activeDemandCount: activeCount, message: `Este usuário possui ${activeCount} demanda(s) ativa(s).` }, 409);
  const changes = [
    { field: "nome", oldValue: existing.displayName, newValue: name },
    { field: "e-mail", oldValue: existing.email, newValue: email },
    { field: "perfil", oldValue: existing.role, newValue: role },
    { field: "status", oldValue: existing.status, newValue: status },
  ].filter((change) => change.oldValue !== change.newValue);
  if (changes.length) {
    await env.DB.prepare("UPDATE users SET display_name = ?, email = ?, role = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(name, email, role, status, id).run();
    for (const change of changes) await addUserHistory(env, id, actor, change.field === "status" ? (status === "active" ? "activated" : "inactivated") : "edited", change.field, change.oldValue, change.newValue);
  }
  const user = await env.DB.prepare(`${userSelect} WHERE id = ?`).bind(id).first<AppUser>();
  return json({ user, activeDemandCount: activeCount });
}

async function handleOperations(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/inbox" && request.method === "GET") {
    await ensureUser(request, env);
    const result = await env.DB.prepare(`
      SELECT i.id, i.channel, i.sender, i.subject, i.body, i.status, i.priority_hint AS priorityHint,
        i.company_id AS companyId, c.trade_name AS company, i.reviewer_id AS reviewerId,
        u.display_name AS reviewer, i.demand_id AS demandId, i.received_at AS receivedAt
      FROM inbox_items i LEFT JOIN companies c ON c.id = i.company_id LEFT JOIN users u ON u.id = i.reviewer_id
      ORDER BY CASE i.status WHEN 'new' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END, i.received_at DESC, i.id DESC`).all();
    return json({ items: result.results });
  }

  if (url.pathname === "/api/inbox" && request.method === "POST") {
    const user = await ensureUser(request, env);
    const payload = await request.json<Record<string, unknown>>();
    const channel = String(payload.channel ?? "manual");
    const sender = String(payload.sender ?? "").trim();
    const subject = String(payload.subject ?? "").trim();
    const body = String(payload.body ?? "").trim();
    const companyId = payload.companyId ? Number(payload.companyId) : null;
    const priorityHint = String(payload.priorityHint ?? "medium");
    if (!["email", "teams", "whatsapp", "manual"].includes(channel) || !sender || !subject || !priorities.has(priorityHint)) return json({ error: "Revise os dados da entrada." }, 400);
    if (companyId && !await activeCompany(env, companyId)) return json({ error: "Empresa inválida ou inativa." }, 400);
    const created = await env.DB.prepare(`
      INSERT INTO inbox_items (channel, sender, subject, body, company_id, priority_hint, reviewer_id)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(channel, sender, subject, body, companyId, priorityHint, user.id).first<{ id: number }>();
    if (!created) throw new Error("Não foi possível registrar a entrada.");
    await createNotification(env, { type: "new_inbox", title: "Nova entrada para triagem", message: subject, inboxItemId: created.id });
    return json({ id: created.id }, 201);
  }

  const inboxConvert = url.pathname.match(/^\/api\/inbox\/(\d+)\/convert$/);
  if (inboxConvert && request.method === "POST") {
    const user = await ensureUser(request, env);
    const id = Number(inboxConvert[1]);
    const item = await env.DB.prepare("SELECT id, channel, sender, subject, body, company_id AS companyId, status, priority_hint AS priorityHint FROM inbox_items WHERE id = ?")
      .bind(id).first<{ id: number; channel: string; sender: string; subject: string; body: string; companyId: number | null; status: string; priorityHint: string }>();
    if (!item) return json({ error: "Entrada não encontrada." }, 404);
    if (item.status === "converted") return json({ error: "Esta entrada já foi convertida." }, 409);
    const payload = await request.json<Record<string, unknown>>();
    const demand = await createDemandRecord(env, user, {
      ...payload,
      companyId: payload.companyId ?? item.companyId,
      requester: payload.requester ?? item.sender,
      description: payload.description ?? `${item.subject}\n\n${item.body}`,
      priority: payload.priority ?? item.priorityHint,
      source: payload.source ?? channelSource(item.channel),
    });
    if (!demand) throw new Error("Não foi possível criar a demanda.");
    await env.DB.prepare("UPDATE inbox_items SET status = 'converted', reviewer_id = ?, demand_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(user.id, demand.id, id).run();
    await createNotification(env, { type: "inbox_converted", title: "Entrada convertida", message: demand.title, demandId: demand.id, inboxItemId: id });
    return json({ demand });
  }

  const inboxMatch = url.pathname.match(/^\/api\/inbox\/(\d+)$/);
  if (inboxMatch && request.method === "PATCH") {
    const user = await ensureUser(request, env);
    const payload = await request.json<{ status?: string }>();
    if (!["new", "reviewing", "archived"].includes(payload.status ?? "")) return json({ error: "Status inválido." }, 400);
    await env.DB.prepare("UPDATE inbox_items SET status = ?, reviewer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(payload.status, user.id, Number(inboxMatch[1])).run();
    return json({ ok: true });
  }

  if (url.pathname === "/api/integrations" && request.method === "GET") {
    await ensureUser(request, env);
    const result = await env.DB.prepare("SELECT id, channel, provider, status, inbound_enabled AS inboundEnabled, outbound_enabled AS outboundEnabled, last_sync_at AS lastSyncAt FROM integration_channels ORDER BY id").all();
    return json({ channels: result.results });
  }
  const integrationMatch = url.pathname.match(/^\/api\/integrations\/(email|teams|whatsapp)$/);
  if (integrationMatch && request.method === "PUT") {
    const user = await ensureUser(request, env); requireFullAccess(user);
    await env.DB.prepare("UPDATE integration_channels SET status = 'pending_credentials', updated_at = CURRENT_TIMESTAMP WHERE channel = ?").bind(integrationMatch[1]).run();
    return json({ status: "pending_credentials", message: "Estrutura preparada. Agora faltam as credenciais da conta oficial." });
  }

  if (url.pathname === "/api/sla-rules" && request.method === "GET") {
    await ensureUser(request, env);
    const result = await env.DB.prepare("SELECT id, category, business_days AS businessDays, default_priority AS defaultPriority, status FROM sla_rules ORDER BY id").all();
    return json({ rules: result.results });
  }
  const slaMatch = url.pathname.match(/^\/api\/sla-rules\/(\d+)$/);
  if (slaMatch && request.method === "PUT") {
    const user = await ensureUser(request, env); requireFullAccess(user);
    const payload = await request.json<{ businessDays?: number; defaultPriority?: string; status?: string }>();
    const days = Number(payload.businessDays);
    const priority = String(payload.defaultPriority ?? "");
    const status = String(payload.status ?? "active");
    if (!Number.isInteger(days) || days < 1 || days > 60 || !priorities.has(priority) || !["active", "inactive"].includes(status)) return json({ error: "Regra de SLA inválida." }, 400);
    await env.DB.prepare("UPDATE sla_rules SET business_days = ?, default_priority = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(days, priority, status, Number(slaMatch[1])).run();
    return json({ ok: true });
  }

  if (url.pathname === "/api/notifications" && request.method === "GET") {
    const user = await ensureUser(request, env);
    const stored = await env.DB.prepare(`SELECT id, type, title, message, demand_id AS demandId, inbox_item_id AS inboxItemId, read, created_at AS createdAt FROM notifications WHERE user_id IS NULL OR user_id = ? ORDER BY created_at DESC, id DESC LIMIT 40`)
      .bind(user.id).all<Record<string, unknown>>();
    const deadlines = await env.DB.prepare(`
      SELECT -id AS id, 'sla' AS type, CASE WHEN due_date < date('now') THEN 'SLA vencido' ELSE 'SLA próximo' END AS title,
        title || ' · prazo ' || due_date AS message, id AS demandId, NULL AS inboxItemId, 0 AS read, due_date AS createdAt
      FROM demands WHERE status <> 'done' AND due_date <= date('now', '+2 day') ORDER BY due_date LIMIT 20`).all<Record<string, unknown>>();
    return json({ notifications: [...deadlines.results, ...stored.results] });
  }
  const notificationMatch = url.pathname.match(/^\/api\/notifications\/(\d+)$/);
  if (notificationMatch && request.method === "PATCH") {
    const user = await ensureUser(request, env);
    await env.DB.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND (user_id IS NULL OR user_id = ?)").bind(Number(notificationMatch[1]), user.id).run();
    return json({ ok: true });
  }

  const demandAttachments = url.pathname.match(/^\/api\/demands\/(\d+)\/attachments$/);
  if (demandAttachments) {
    const user = await ensureUser(request, env);
    const demandId = Number(demandAttachments[1]);
    if (!await getDemand(env, demandId)) return json({ error: "Demanda não encontrada." }, 404);
    if (request.method === "GET") {
      const result = await env.DB.prepare(`SELECT a.id, a.file_name AS fileName, a.content_type AS contentType, a.size, a.created_at AS createdAt, u.display_name AS uploader FROM demand_attachments a JOIN users u ON u.id = a.uploader_id WHERE a.demand_id = ? ORDER BY a.created_at DESC, a.id DESC`).bind(demandId).all();
      return json({ attachments: result.results });
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0 || file.size > 10 * 1024 * 1024) return json({ error: "Envie um arquivo de até 10 MB." }, 400);
      const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120) || "arquivo";
      const objectKey = `demands/${demandId}/${crypto.randomUUID()}-${safeFileName}`;
      await env.BUCKET.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream", contentDisposition: `attachment; filename="${safeFileName}"` } });
      await env.DB.prepare("INSERT INTO demand_attachments (demand_id, uploader_id, file_name, content_type, size, object_key) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(demandId, user.id, file.name.slice(0, 240), file.type || "application/octet-stream", file.size, objectKey).run();
      await addDemandHistory(env, demandId, "attachment_added", `Arquivo anexado: ${file.name.slice(0, 240)}`, user);
      return json({ ok: true }, 201);
    }
  }

  const attachmentDownload = url.pathname.match(/^\/api\/attachments\/(\d+)\/download$/);
  if (attachmentDownload && request.method === "GET") {
    await ensureUser(request, env);
    const attachment = await env.DB.prepare("SELECT file_name AS fileName, content_type AS contentType, object_key AS objectKey FROM demand_attachments WHERE id = ?")
      .bind(Number(attachmentDownload[1])).first<{ fileName: string; contentType: string; objectKey: string }>();
    if (!attachment) return json({ error: "Arquivo não encontrado." }, 404);
    const object = await env.BUCKET.get(attachment.objectKey);
    if (!object) return json({ error: "Arquivo não encontrado no armazenamento." }, 404);
    return new Response(object.body, { headers: { "Content-Type": attachment.contentType, "Content-Disposition": `attachment; filename="${attachment.fileName.replace(/["\r\n]/g, "")}"` } });
  }
  return null;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        const response = await handleOperations(request, env, url)
          ?? await handleDemands(request, env, url)
          ?? await handleCompanies(request, env, url)
          ?? await handleLabels(request, env, url)
          ?? await handleTemplates(request, env, url)
          ?? await handleUsers(request, env, url);
        return response ?? json({ error: "Rota não encontrada." }, 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro inesperado";
        if (message === "ADMIN_REQUIRED") return json({ error: "Acesso restrito ao administrador." }, 403);
        if (message.startsWith("ACESSO_NAO_CADASTRADO") || message.startsWith("USUARIO_INATIVO")) return json({ error: message }, 403);
        const friendly = message.includes("no such table") || message.includes("no column named")
          ? "O banco de dados ainda está sendo atualizado. Tente novamente em instantes."
          : message;
        return json({ error: friendly }, 500);
      }
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
