import { safeRelativeReturnPath, setAuthSession, verifyPassword } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { checkLoginRateLimit, clearLoginIdentityFailures, clientAddress, recordLoginFailure } from "@/lib/auth-rate-limit";
import { isPlatformAdmin } from "@/lib/platform-authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cleanReturnTo(value: unknown) {
  return typeof value === "string" ? safeRelativeReturnPath(value) || "/painel" : "/painel";
}

type LoginBody = { email?: string; password?: string; mode?: string; returnTo?: string };
type UserRow = {
  id: string; email: string; name: string; password_hash: string | null; password_salt: string | null;
  status?: string; status_reason?: string;
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as LoginBody;
    if (body.mode === "bootstrap") {
      return Response.json({
        error: "Workspaces são criados somente pelo administrador global no Console Global.",
        code: "PLATFORM_PROVISIONING_REQUIRED",
      }, { status: 403 });
    }

    if (process.env.NODE_ENV === "production" && !process.env.FDP_AUTH_SECRET) {
      return Response.json(
        { error: "A autenticação do site não está configurada. Defina FDP_AUTH_SECRET na Vercel." },
        { status: 503 },
      );
    }

    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!/^\S+@\S+\.\S+$/u.test(email)) return Response.json({ error: "Informe um e-mail válido." }, { status: 400 });
    if (password.length < 8 || password.length > 200) return Response.json({ error: "A senha deve ter entre 8 e 200 caracteres." }, { status: 400 });

    const address = clientAddress(request);
    const rateLimit = await checkLoginRateLimit(email, address);
    if (!rateLimit.allowed) {
      return Response.json(
        { error: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds), "Cache-Control": "no-store" } },
      );
    }

    const d1 = getD1();
    const current = await d1.prepare(`SELECT id, email, name, password_hash, password_salt, status, status_reason
      FROM fdp_users WHERE email = ?`).bind(email).first<UserRow>();
    if (current?.status === "blocked") {
      await recordLoginFailure(email, address);
      return Response.json(
        { error: "Seu acesso está bloqueado. Fale com o administrador da plataforma.", code: "USER_BLOCKED" },
        { status: 403 },
      );
    }

    if (!current || !current.password_hash || !current.password_salt
      || !await verifyPassword(password, current.password_salt, current.password_hash)) {
      const failure = await recordLoginFailure(email, address);
      if (failure.blocked) {
        return Response.json(
          { error: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente." },
          { status: 429, headers: { "Retry-After": String(failure.retryAfterSeconds), "Cache-Control": "no-store" } },
        );
      }
      return Response.json({ error: "E-mail ou senha incorretos." }, { status: 401 });
    }

    const identity = { id: current.id, email: current.email, displayName: current.name, fullName: current.name };
    const platformAdmin = isPlatformAdmin(identity);
    const access = await d1.prepare("SELECT 1 AS granted FROM fdp_workspace_members WHERE user_id = ? LIMIT 1")
      .bind(current.id).first<{ granted: number }>();
    if (!access && !platformAdmin) {
      return Response.json({ error: "Seu acesso ainda não foi liberado por um administrador." }, { status: 403 });
    }

    await clearLoginIdentityFailures(email, address);
    await setAuthSession(identity, { address, userAgent: request.headers.get("user-agent") ?? "" });
    return Response.json({
      ok: true,
      redirectTo: platformAdmin && !access ? "/plataforma" : cleanReturnTo(body.returnTo),
    });
  } catch (error) {
    console.error("Vinculato login failed", error);
    return Response.json({ error: "Não foi possível iniciar a sessão. Tente novamente." }, { status: 500 });
  }
}
