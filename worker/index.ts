/** Cloudflare Worker entry point for Fila DP. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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

type DemandRow = {
  id: number;
  title: string;
  description: string;
  category: string;
  company: string;
  employee: string | null;
  requester: string;
  source: "E-mail" | "WhatsApp" | "Verbal";
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
};

type DemandHistoryRow = {
  id: number;
  demandId: number;
  action: string;
  details: string;
  userEmail: string;
  userName: string;
  userId: number | null;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  justification: string | null;
  createdAt: string;
};

const demandSelect = `
  SELECT id, title, description, category, company, employee, requester, source,
    priority, due_date AS dueDate, status, assignee_email AS assigneeEmail,
    assignee_name AS assignee, created_by_email AS createdByEmail,
    created_at AS createdAt, updated_at AS updatedAt, version,
    updated_by_id AS updatedById
  FROM demands`;

const userSelect = `
  SELECT id, email, display_name AS displayName, role, status,
    created_at AS createdAt, created_by_id AS createdById,
    updated_at AS updatedAt, last_access_at AS lastAccessAt
  FROM users`;

const historySelect = `
  SELECT id, demand_id AS demandId, action, details, user_email AS userEmail,
    user_name AS userName, user_id AS userId, field_changed AS fieldChanged,
    old_value AS oldValue, new_value AS newValue, justification,
    created_at AS createdAt
  FROM demand_history`;

const categories = new Set(["Admissão", "Férias", "Rescisão", "Ponto", "Folha", "Benefícios", "Afastamento", "eSocial", "Atendimento", "Outros"]);
const sources = new Set(["E-mail", "WhatsApp", "Verbal"]);
const priorities = new Set(["low", "medium", "high", "urgent"]);
const statuses = new Set<DemandStatus>(["available", "in_progress", "waiting", "done"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const editableFields = {
  priority: { column: "priority", label: "prioridade", structural: false },
  dueDate: { column: "due_date", label: "prazo", structural: false },
  description: { column: "description", label: "descrição", structural: false },
  category: { column: "category", label: "tipo", structural: true },
  source: { column: "source", label: "canal de origem", structural: true },
  company: { column: "company", label: "empresa", structural: true },
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

async function ensureUser(request: Request, env: Env): Promise<AppUser> {
  const email = request.headers.get("oai-authenticated-user-email") ?? "rian@filadp.local";
  const authenticatedName = safeName(request);
  let user = await env.DB.prepare(`${userSelect} WHERE email = ? LIMIT 1`).bind(email).first<AppUser>();

  if (!user) {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>();
    if (Number(countRow?.total ?? 0) > 0) {
      throw new Error("ACESSO_NAO_CADASTRADO: peça a um administrador para cadastrar seu e-mail.");
    }
    const displayName = authenticatedName ?? (email === "rian@filadp.local" ? "Rian Oliveira" : email);
    await env.DB.prepare("INSERT INTO users (email, display_name, role, status, last_access_at) VALUES (?, ?, 'admin', 'active', CURRENT_TIMESTAMP)")
      .bind(email, displayName).run();
    user = await env.DB.prepare(`${userSelect} WHERE email = ? LIMIT 1`).bind(email).first<AppUser>();
  }

  if (!user) throw new Error("Não foi possível preparar o usuário.");
  if (user.status === "inactive") throw new Error("USUARIO_INATIVO: seu acesso está inativo.");
  await env.DB.prepare("UPDATE users SET last_access_at = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id).run();
  return { ...user, lastAccessAt: new Date().toISOString() };
}

function requireAdmin(user: AppUser) {
  if (user.role !== "admin") throw new Error("ADMIN_REQUIRED");
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      demandId,
      action,
      details,
      user.email,
      user.displayName,
      user.id,
      change?.fieldChanged ?? null,
      change?.oldValue == null ? null : String(change.oldValue),
      change?.newValue == null ? null : String(change.newValue),
      change?.justification ?? null,
    ).run();
}

async function addUserHistory(env: Env, targetUserId: number, actor: AppUser, action: string, field?: string, oldValue?: unknown, newValue?: unknown) {
  await env.DB.prepare(`
    INSERT INTO user_history (target_user_id, actor_user_id, action, field_changed, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(targetUserId, actor.id, action, field ?? null, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue)).run();
}

async function getDemand(env: Env, id: number) {
  return env.DB.prepare(`${demandSelect} WHERE id = ? LIMIT 1`).bind(id).first<DemandRow>();
}

function canEditDemand(user: AppUser, demand: DemandRow) {
  if (user.role === "admin") return true;
  if (demand.status === "available") return true;
  if (demand.status === "done") return false;
  return demand.assigneeEmail === user.email;
}

async function handleDemands(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/demands" && request.method === "GET") {
    const user = await ensureUser(request, env);
    const result = await env.DB.prepare(`${demandSelect} ORDER BY created_at DESC, id DESC`).all<DemandRow>();
    return json({ demands: result.results, user: { name: user.displayName, email: user.email, role: user.role } });
  }

  if (url.pathname === "/api/demands" && request.method === "POST") {
    const user = await ensureUser(request, env);
    const payload = await request.json<Record<string, unknown>>();
    const category = String(payload.category ?? "").trim();
    const company = String(payload.company ?? "").trim();
    const employee = String(payload.employee ?? "").trim();
    const requester = String(payload.requester ?? "").trim();
    const source = String(payload.source ?? "");
    const priority = String(payload.priority ?? "medium");
    const dueDate = String(payload.dueDate ?? "");
    const description = String(payload.description ?? "").trim();
    if (!categories.has(category) || !company || !requester || !sources.has(source) || !priorities.has(priority) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return json({ error: "Revise os campos obrigatórios da demanda." }, 400);
    }
    const title = `${category} – ${employee || company}`;
    const insert = await env.DB.prepare(`
      INSERT INTO demands (title, description, category, company, employee, requester, source, priority, due_date, created_by_email, updated_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(title, description, category, company, employee || null, requester, source, priority, dueDate, user.email, user.id)
      .first<{ id: number }>();
    if (!insert) throw new Error("Não foi possível cadastrar a demanda.");
    await addDemandHistory(env, insert.id, "created", `Demanda cadastrada via ${source}`, user);
    return json({ demand: await getDemand(env, insert.id) }, 201);
  }

  const historyMatch = url.pathname.match(/^\/api\/demands\/(\d+)\/history$/);
  if (historyMatch && request.method === "GET") {
    await ensureUser(request, env);
    const result = await env.DB.prepare(`${historySelect} WHERE demand_id = ? ORDER BY created_at DESC, id DESC`)
      .bind(Number(historyMatch[1])).all<DemandHistoryRow>();
    return json({ history: result.results });
  }

  const match = url.pathname.match(/^\/api\/demands\/(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  const user = await ensureUser(request, env);
  const existing = await getDemand(env, id);
  if (!existing) return json({ error: "Demanda não encontrada." }, 404);

  if (request.method === "GET") {
    return json({ demand: existing, canEdit: canEditDemand(user, existing), editableStructuralFields: user.role === "admin" });
  }

  if (request.method === "PUT") {
    const payload = await request.json<Record<string, unknown>>();
    const receivedVersion = Number(payload.version);
    if (receivedVersion !== existing.version) {
      return json({ error: "CONFLITO_VERSAO", message: "Esta demanda foi alterada por outro usuário. Recarregue os dados antes de editar.", currentVersion: existing.version }, 409);
    }
    if (!canEditDemand(user, existing)) return json({ error: "Você não tem permissão para editar esta demanda." }, 403);
    const justification = String(payload.justification ?? "").trim();
    if (existing.status === "done" && user.role === "admin" && !justification) {
      return json({ error: "JUSTIFICATIVA_OBRIGATORIA", message: "É necessário informar o motivo para editar uma demanda concluída." }, 422);
    }

    const changes: Array<{ key: keyof typeof editableFields; column: string; label: string; oldValue: unknown; newValue: unknown }> = [];
    for (const key of Object.keys(editableFields) as Array<keyof typeof editableFields>) {
      if (!(key in payload)) continue;
      const config = editableFields[key];
      if (config.structural && user.role !== "admin") {
        return json({ error: "CAMPO_NAO_EDITAVEL", message: `Apenas administradores podem editar o campo '${config.label}'.` }, 403);
      }
      const newValue = key === "employee" ? (String(payload[key] ?? "").trim() || null) : String(payload[key] ?? "").trim();
      const oldValue = existing[key];
      if (String(oldValue ?? "") !== String(newValue ?? "")) changes.push({ key, column: config.column, label: config.label, oldValue, newValue });
    }
    if (changes.length === 0) return json({ demand: existing, changedFields: [] });

    const nextValues = Object.fromEntries(changes.map((change) => [change.key, change.newValue])) as Record<string, unknown>;
    if (nextValues.category && !categories.has(String(nextValues.category))) return json({ error: "Tipo de demanda inválido." }, 400);
    if (nextValues.source && !sources.has(String(nextValues.source))) return json({ error: "Canal de origem inválido." }, 400);
    if (nextValues.priority && !priorities.has(String(nextValues.priority))) return json({ error: "Prioridade inválida." }, 400);
    if (nextValues.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(nextValues.dueDate))) return json({ error: "Prazo inválido." }, 400);

    const finalCategory = String(nextValues.category ?? existing.category);
    const finalCompany = String(nextValues.company ?? existing.company);
    const finalEmployee = nextValues.employee !== undefined ? nextValues.employee : existing.employee;
    const title = `${finalCategory} – ${finalEmployee || finalCompany}`;
    const assignments = changes.map((change) => `${change.column} = ?`);
    const values = changes.map((change) => change.newValue);
    assignments.push("title = ?", "version = version + 1", "updated_at = CURRENT_TIMESTAMP", "updated_by_id = ?");
    values.push(title, user.id, id, existing.version);
    const updated = await env.DB.prepare(`UPDATE demands SET ${assignments.join(", ")} WHERE id = ? AND version = ? RETURNING id`)
      .bind(...values).first<{ id: number }>();
    if (!updated) return json({ error: "CONFLITO_VERSAO", message: "Esta demanda foi alterada por outro usuário. Recarregue os dados antes de editar." }, 409);
    for (const change of changes) {
      await addDemandHistory(env, id, "edited", `${change.label} alterado`, user, {
        fieldChanged: change.label,
        oldValue: change.oldValue,
        newValue: change.newValue,
        justification: justification || undefined,
      });
    }
    return json({ demand: await getDemand(env, id), changedFields: changes.map((change) => change.key) });
  }

  if (request.method !== "PATCH") return null;
  const payload = await request.json<{ action?: string; status?: string; justification?: string }>();

  if (payload.action === "claim") {
    const updated = await env.DB.prepare(`
      UPDATE demands SET status = 'in_progress', assignee_email = ?, assignee_name = ?,
        updated_at = CURRENT_TIMESTAMP, updated_by_id = ?, version = version + 1
      WHERE id = ? AND assignee_email IS NULL AND status = 'available' RETURNING id`)
      .bind(user.email, user.displayName, user.id, id).first<{ id: number }>();
    if (!updated) return json({ error: "Outro analista assumiu esta demanda primeiro." }, 409);
    await addDemandHistory(env, id, "claimed", "Demanda assumida", user);
    return json({ demand: await getDemand(env, id) });
  }

  if (payload.action === "move" && payload.status && statuses.has(payload.status as DemandStatus)) {
    if (existing.assigneeEmail && existing.assigneeEmail !== user.email && user.role !== "admin") {
      return json({ error: "Somente o responsável ou um administrador pode movimentar esta demanda." }, 403);
    }
    const status = payload.status as DemandStatus;
    if (existing.status === "done" && status !== "done") {
      if (user.role !== "admin") return json({ error: "Somente administradores podem reabrir demandas concluídas." }, 403);
      if (!payload.justification?.trim()) return json({ error: "JUSTIFICATIVA_OBRIGATORIA", message: "Informe o motivo para reabrir a demanda." }, 422);
    }
    const assigneeEmail = status === "available" ? null : (existing.assigneeEmail ?? user.email);
    const assigneeName = status === "available" ? null : (existing.assignee ?? user.displayName);
    await env.DB.prepare(`
      UPDATE demands SET status = ?, assignee_email = ?, assignee_name = ?, updated_at = CURRENT_TIMESTAMP,
        updated_by_id = ?, version = version + 1 WHERE id = ?`)
      .bind(status, assigneeEmail, assigneeName, user.id, id).run();
    const action = existing.status === "done" && status !== "done" ? "reopened" : status === "available" ? "returned" : "status_changed";
    await addDemandHistory(env, id, action, `Status alterado de ${existing.status} para ${status}`, user, {
      fieldChanged: "status",
      oldValue: existing.status,
      newValue: status,
      justification: payload.justification,
    });
    return json({ demand: await getDemand(env, id) });
  }
  return json({ error: "Ação inválida." }, 400);
}

async function activeDemandCount(env: Env, email: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM demands WHERE assignee_email = ? AND status IN ('in_progress', 'waiting')")
    .bind(email).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function handleUsers(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/users" && request.method === "GET") {
    const currentUser = await ensureUser(request, env);
    requireAdmin(currentUser);
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
    requireAdmin(actor);
    const payload = await request.json<{ name?: string; email?: string; role?: string }>();
    const name = payload.name?.trim() ?? "";
    const email = payload.email?.trim().toLowerCase() ?? "";
    const role = payload.role ?? "analyst";
    if (name.length < 3 || !emailPattern.test(email) || !["admin", "analyst"].includes(role)) return json({ error: "Revise nome, e-mail e perfil." }, 400);
    const duplicate = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first<{ id: number }>();
    if (duplicate) return json({ error: "Este e-mail já está cadastrado." }, 409);
    const created = await env.DB.prepare(`
      INSERT INTO users (display_name, email, role, status, created_by_id, updated_at)
      VALUES (?, ?, ?, 'active', ?, CURRENT_TIMESTAMP) RETURNING id`)
      .bind(name, email, role, actor.id).first<{ id: number }>();
    if (!created) throw new Error("Não foi possível criar o usuário.");
    await addUserHistory(env, created.id, actor, "created");
    const user = await env.DB.prepare(`${userSelect} WHERE id = ?`).bind(created.id).first<AppUser>();
    return json({ user, accessMessage: "O usuário acessará com a conta ChatGPT vinculada a este e-mail." }, 201);
  }

  const historyMatch = url.pathname.match(/^\/api\/users\/(\d+)\/history$/);
  if (historyMatch && request.method === "GET") {
    const actor = await ensureUser(request, env);
    requireAdmin(actor);
    const result = await env.DB.prepare(`
      SELECT h.id, h.action, h.field_changed AS fieldChanged, h.old_value AS oldValue,
        h.new_value AS newValue, h.created_at AS createdAt,
        u.display_name AS actorName
      FROM user_history h JOIN users u ON u.id = h.actor_user_id
      WHERE h.target_user_id = ? ORDER BY h.created_at DESC, h.id DESC`)
      .bind(Number(historyMatch[1])).all();
    return json({ history: result.results });
  }

  const statusMatch = url.pathname.match(/^\/api\/users\/(\d+)\/status$/);
  const match = url.pathname.match(/^\/api\/users\/(\d+)$/);
  if (!statusMatch && !match) return null;
  const id = Number((statusMatch ?? match)![1]);
  const actor = await ensureUser(request, env);
  requireAdmin(actor);
  const existing = await env.DB.prepare(`${userSelect} WHERE id = ? LIMIT 1`).bind(id).first<AppUser>();
  if (!existing) return json({ error: "Usuário não encontrado." }, 404);

  if (request.method === "GET") {
    return json({ user: existing, activeDemandCount: await activeDemandCount(env, existing.email) });
  }

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
    for (const change of changes) {
      await addUserHistory(env, id, actor, change.field === "status" ? (status === "active" ? "activated" : "inactivated") : "edited", change.field, change.oldValue, change.newValue);
    }
  }
  const user = await env.DB.prepare(`${userSelect} WHERE id = ?`).bind(id).first<AppUser>();
  return json({ user, activeDemandCount: activeCount });
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

    if (url.pathname.startsWith("/api/demands") || url.pathname.startsWith("/api/users")) {
      try {
        const response = await handleDemands(request, env, url) ?? await handleUsers(request, env, url);
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
