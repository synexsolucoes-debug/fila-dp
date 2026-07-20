import { hashPassword, setAuthSession, verifyPassword } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { ensureSchema } from "@/lib/fila-dp-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cleanReturnTo(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/painel";
  return value;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: string; password?: string; name?: string; mode?: string; returnTo?: string };
    if (process.env.NODE_ENV === "production" && !process.env.FDP_AUTH_SECRET) {
      return Response.json({ error: "A autenticação do site não está configurada. Defina FDP_AUTH_SECRET na Vercel." }, { status: 503 });
    }
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const mode = body.mode === "register" ? "register" : "login";
    if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Informe um e-mail válido." }, { status: 400 });
    if (password.length < 8 || password.length > 200) return Response.json({ error: "A senha deve ter entre 8 e 200 caracteres." }, { status: 400 });

    await ensureSchema();
    const d1 = getD1();
    const current = await d1.prepare("SELECT id, email, name, password_hash, password_salt FROM fdp_users WHERE email = ?").bind(email).first<{ id: string; email: string; name: string; password_hash: string | null; password_salt: string | null }>();

    if (mode === "register") {
      const name = String(body.name ?? "").trim().slice(0, 160);
      if (name.length < 2) return Response.json({ error: "Informe seu nome completo." }, { status: 400 });
      const credentials = hashPassword(password);
      if (current) {
        if (current.password_hash) return Response.json({ error: "Este e-mail já possui uma conta. Entre com sua senha." }, { status: 409 });
        await d1.prepare("UPDATE fdp_users SET name = ?, password_hash = ?, password_salt = ? WHERE id = ?").bind(name, credentials.hash, credentials.salt, current.id).run();
      } else {
        await d1.prepare("INSERT INTO fdp_users (id, email, name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), email, name, credentials.hash, credentials.salt).run();
      }
    } else {
      if (!current || !current.password_hash || !current.password_salt || !verifyPassword(password, current.password_salt, current.password_hash)) {
        return Response.json({ error: "E-mail ou senha incorretos." }, { status: 401 });
      }
    }

    const user = await d1.prepare("SELECT id, email, name FROM fdp_users WHERE email = ?").bind(email).first<{ id: string; email: string; name: string }>();
    if (!user) return Response.json({ error: "Não foi possível criar a sessão." }, { status: 500 });
    await setAuthSession({ id: user.id, email: user.email, displayName: user.name, fullName: user.name });
    return Response.json({ ok: true, redirectTo: cleanReturnTo(body.returnTo) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Não foi possível entrar.";
    return Response.json({ error: message }, { status: 500 });
  }
}
