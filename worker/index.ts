/** Cloudflare Worker entry point for the vinext-starter template. */
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

type AppUser = {
  id: number;
  email: string;
  displayName: string;
  role: "admin" | "analyst";
  createdAt: string;
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
  status: "available" | "in_progress" | "waiting" | "done";
  assigneeEmail: string | null;
  assignee: string | null;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
};

const demandSelect = `
  SELECT id, title, description, category, company, employee, requester, source,
    priority, due_date AS dueDate, status, assignee_email AS assigneeEmail,
    assignee_name AS assignee, created_by_email AS createdByEmail,
    created_at AS createdAt, updated_at AS updatedAt
  FROM demands`;

const userSelect = `
  SELECT id, email, display_name AS displayName, role, created_at AS createdAt
  FROM users`;

const categories = new Set(["Admissão", "Férias", "Rescisão", "Ponto", "Folha", "Benefícios", "Afastamento", "eSocial", "Atendimento", "Outros"]);
const sources = new Set(["E-mail", "WhatsApp", "Verbal"]);
const priorities = new Set(["low", "medium", "high", "urgent"]);
const statuses = new Set(["available", "in_progress", "waiting", "done"]);

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
  const displayName = safeName(request) ?? (email === "rian@filadp.local" ? "Rian Oliveira" : email);
  const existing = await env.DB.prepare(`${userSelect} WHERE email = ? LIMIT 1`).bind(email).first<AppUser>();
  if (existing) {
    if (existing.displayName !== displayName) {
      await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(displayName, existing.id).run();
      return { ...existing, displayName };
    }
    return existing;
  }

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first<{ total: number }>();
  const role = Number(countRow?.total ?? 0) === 0 ? "admin" : "analyst";
  await env.DB.prepare("INSERT OR IGNORE INTO users (email, display_name, role) VALUES (?, ?, ?)").bind(email, displayName, role).run();
  const created = await env.DB.prepare(`${userSelect} WHERE email = ? LIMIT 1`).bind(email).first<AppUser>();
  if (!created) throw new Error("Não foi possível preparar o usuário.");
  return created;
}

async function addHistory(env: Env, demandId: number, action: string, details: string, user: AppUser) {
  await env.DB.prepare("INSERT INTO demand_history (demand_id, action, details, user_email, user_name) VALUES (?, ?, ?, ?, ?)")
    .bind(demandId, action, details, user.email, user.displayName).run();
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
      INSERT INTO demands (title, description, category, company, employee, requester, source, priority, due_date, created_by_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(title, description, category, company, employee || null, requester, source, priority, dueDate, user.email)
      .first<{ id: number }>();
    if (!insert) throw new Error("Não foi possível cadastrar a demanda.");
    await addHistory(env, insert.id, "created", `Demanda cadastrada via ${source}`, user);
    const demand = await env.DB.prepare(`${demandSelect} WHERE id = ?`).bind(insert.id).first<DemandRow>();
    return json({ demand }, 201);
  }

  const match = url.pathname.match(/^\/api\/demands\/(\d+)$/);
  if (!match || request.method !== "PATCH") return null;
  const id = Number(match[1]);
  const user = await ensureUser(request, env);
  const payload = await request.json<{ action?: string; status?: string }>();
  const existing = await env.DB.prepare(`${demandSelect} WHERE id = ? LIMIT 1`).bind(id).first<DemandRow>();
  if (!existing) return json({ error: "Demanda não encontrada." }, 404);

  if (payload.action === "claim") {
    const updated = await env.DB.prepare(`
      UPDATE demands SET status = 'in_progress', assignee_email = ?, assignee_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND assignee_email IS NULL AND status = 'available' RETURNING id`)
      .bind(user.email, user.displayName, id).first<{ id: number }>();
    if (!updated) return json({ error: "Outro analista assumiu esta demanda primeiro." }, 409);
    await addHistory(env, id, "claimed", "Demanda assumida", user);
    const demand = await env.DB.prepare(`${demandSelect} WHERE id = ?`).bind(id).first<DemandRow>();
    return json({ demand });
  }

  if (payload.action === "move" && payload.status && statuses.has(payload.status)) {
    if (existing.assigneeEmail && existing.assigneeEmail !== user.email && user.role !== "admin") {
      return json({ error: "Somente o responsável ou um administrador pode movimentar esta demanda." }, 403);
    }
    const status = payload.status;
    const assigneeEmail = status === "available" ? null : (existing.assigneeEmail ?? user.email);
    const assigneeName = status === "available" ? null : (existing.assignee ?? user.displayName);
    await env.DB.prepare("UPDATE demands SET status = ?, assignee_email = ?, assignee_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(status, assigneeEmail, assigneeName, id).run();
    await addHistory(env, id, "status_changed", `Status alterado para ${status}`, user);
    const demand = await env.DB.prepare(`${demandSelect} WHERE id = ?`).bind(id).first<DemandRow>();
    return json({ demand });
  }
  return json({ error: "Ação inválida." }, 400);
}

async function handleUsers(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/users" && request.method === "GET") {
    const currentUser = await ensureUser(request, env);
    const result = currentUser.role === "admin"
      ? await env.DB.prepare(`${userSelect} ORDER BY display_name ASC`).all<AppUser>()
      : { results: [currentUser] };
    return json({ users: result.results, currentUser });
  }

  const match = url.pathname.match(/^\/api\/users\/(\d+)$/);
  if (!match || request.method !== "PATCH") return null;
  const currentUser = await ensureUser(request, env);
  if (currentUser.role !== "admin") return json({ error: "Acesso restrito ao administrador." }, 403);
  const id = Number(match[1]);
  const payload = await request.json<{ role?: string }>();
  if (!payload.role || !["admin", "analyst"].includes(payload.role)) return json({ error: "Dados inválidos." }, 400);
  if (id === currentUser.id && payload.role !== "admin") return json({ error: "Você não pode remover seu próprio acesso administrativo." }, 400);
  const updated = await env.DB.prepare("UPDATE users SET role = ? WHERE id = ? RETURNING id").bind(payload.role, id).first<{ id: number }>();
  if (!updated) return json({ error: "Usuário não encontrado." }, 404);
  const user = await env.DB.prepare(`${userSelect} WHERE id = ?`).bind(id).first<AppUser>();
  return json({ user });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

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
        const friendly = message.includes("no such table")
          ? "O banco de dados ainda está sendo preparado. Tente novamente em instantes."
          : message;
        return json({ error: friendly }, 500);
      }
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
