import { hashPassword, setAuthSession, verifyPassword } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { provisionWorkspaceDefaults } from "@/lib/fila-dp-db";
import { assertAuthAttemptAllowed, AuthRateLimitError, authRateLimitResponse, clearAuthFailures, registerAuthFailure } from "@/lib/fila-dp-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cleanReturnTo(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/painel";
  return value;
}

function workspaceSlug(name: string) {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 42) || "grupo";
  return `${normalized}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

type LoginBody = { email?: string; password?: string; name?: string; groupName?: string; mode?: string; returnTo?: string };
type UserRow = { id: string; email: string; name: string; password_hash: string | null; password_salt: string | null };

export async function POST(request: Request) {
  try {
    const body = await request.json() as LoginBody;
    if (process.env.NODE_ENV === "production" && !process.env.FDP_AUTH_SECRET) {
      return Response.json({ error: "A autenticação do site não está configurada. Defina FDP_AUTH_SECRET na Vercel." }, { status: 503 });
    }
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const mode = body.mode === "bootstrap" ? "bootstrap" : "login";
    if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Informe um e-mail válido." }, { status: 400 });
    if (password.length < 8 || password.length > 200) return Response.json({ error: "A senha deve ter entre 8 e 200 caracteres." }, { status: 400 });

    const d1 = getD1();
    const rateLimitKey = await assertAuthAttemptAllowed(request, email, mode);
    const current = await d1.prepare("SELECT id, email, name, password_hash, password_salt FROM fdp_users WHERE email = ?").bind(email).first<UserRow>();

    if (mode === "bootstrap") {
      const existingWorkspace = await d1.prepare("SELECT id FROM fdp_workspaces LIMIT 1").first<{ id: string }>();
      if (existingWorkspace) return Response.json({ error: "O grupo já foi configurado. Solicite ao administrador a liberação do seu acesso." }, { status: 403 });
      const name = String(body.name ?? "").trim().slice(0, 160);
      const groupName = String(body.groupName ?? "").trim().slice(0, 60);
      if (name.length < 2) return Response.json({ error: "Informe seu nome completo." }, { status: 400 });
      if (groupName.length < 2) return Response.json({ error: "Informe o nome do grupo empresarial." }, { status: 400 });
      const credentials = await hashPassword(password);
      const userId = current?.id ?? crypto.randomUUID();
      if (current) {
        if (current.password_hash) return Response.json({ error: "Este e-mail já possui uma conta. Entre com sua senha." }, { status: 409 });
        await d1.prepare("UPDATE fdp_users SET name = ?, password_hash = ?, password_salt = ? WHERE id = ?").bind(name, credentials.hash, credentials.salt, current.id).run();
      } else {
        await d1.prepare("INSERT INTO fdp_users (id, email, name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)").bind(userId, email, name, credentials.hash, credentials.salt).run();
      }
      const workspaceId = crypto.randomUUID();
      await d1.batch([
        d1.prepare("INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)").bind(workspaceId, groupName, workspaceSlug(groupName), userId),
        d1.prepare("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')").bind(workspaceId, userId),
        d1.prepare("INSERT INTO fdp_user_workspace_preferences (user_id, active_workspace_id, active_board_id, updated_at) VALUES (?, ?, NULL, CURRENT_TIMESTAMP)").bind(userId, workspaceId),
      ]);
      const boardId = crypto.randomUUID();
      await d1.batch([
        d1.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, 'Fila geral', 'Operação central do Departamento Pessoal', 'general')").bind(boardId, workspaceId),
        d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Novas demandas', 'new', 1000, 'running')").bind(crypto.randomUUID(), boardId),
        d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Em análise', 'analysis', 2000, 'running')").bind(crypto.randomUUID(), boardId),
        d1.prepare("INSERT INTO fdp_lists (id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, 'Concluído', 'done', 3000, 'completed')").bind(crypto.randomUUID(), boardId),
        d1.prepare("UPDATE fdp_user_workspace_preferences SET active_board_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?").bind(boardId, userId),
      ]);
      await provisionWorkspaceDefaults(d1, workspaceId);
    } else {
      if (!current || !current.password_hash || !current.password_salt || !await verifyPassword(password, current.password_salt, current.password_hash)) {
        await registerAuthFailure(rateLimitKey);
        return Response.json({ error: "E-mail ou senha incorretos." }, { status: 401 });
      }
      const access = await d1.prepare("SELECT 1 AS granted FROM fdp_workspace_members WHERE user_id = ? LIMIT 1").bind(current.id).first<{ granted: number }>();
      if (!access) return Response.json({ error: "Seu acesso ainda não foi liberado por um administrador." }, { status: 403 });
    }

    const user = await d1.prepare("SELECT id, email, name FROM fdp_users WHERE email = ?").bind(email).first<{ id: string; email: string; name: string }>();
    if (!user) return Response.json({ error: "Não foi possível iniciar a sessão." }, { status: 500 });
    await clearAuthFailures(rateLimitKey);
    await setAuthSession({ id: user.id, email: user.email, displayName: user.name, fullName: user.name });
    return Response.json({ ok: true, redirectTo: cleanReturnTo(body.returnTo) });
  } catch (error) {
    if (error instanceof AuthRateLimitError) return authRateLimitResponse(error);
    const message = error instanceof Error ? error.message : "Não foi possível entrar.";
    return Response.json({ error: message }, { status: 500 });
  }
}
