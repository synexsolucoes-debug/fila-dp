import { createSessionToken, safeRelativeReturnPath, setAuthSession, verifyPassword } from "@/lib/auth/session";
import { getD1 } from "@/db";
import { checkLoginRateLimit, clearLoginIdentityFailures, clientAddress, recordLoginFailure } from "@/lib/auth-rate-limit";
import { isPlatformAdmin } from "@/lib/platform-authorization";
import { recordAuthEvent } from "@/lib/auth-events";
import { log, requestIdFrom } from "@/lib/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sem destino específico, a entrada é a janela de módulos do painel. Um link
 *  para uma tela ou demanda continua indo direto para ela. */
const ENTRY_PATH = "/painel?modulos=1";

function cleanReturnTo(value: unknown) {
  const path = typeof value === "string" ? safeRelativeReturnPath(value) : "";
  return !path || path === "/painel" ? ENTRY_PATH : path;
}

type LoginBody = { email?: string; password?: string; mode?: string; returnTo?: string; client?: string };
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
    const userAgent = request.headers.get("user-agent") ?? "";
    const requestId = request.headers.get("x-fila-dp-request-id");
    const trail = { email, address, userAgent, requestId };

    if (current?.status === "blocked") {
      await recordLoginFailure(email, address);
      await recordAuthEvent({ ...trail, action: "login", outcome: "denied", userId: current.id, reason: "conta bloqueada" });
      return Response.json(
        { error: "Seu acesso está bloqueado. Fale com o administrador da plataforma.", code: "USER_BLOCKED" },
        { status: 403 },
      );
    }

    if (!current || !current.password_hash || !current.password_salt
      || !await verifyPassword(password, current.password_salt, current.password_hash)) {
      const failure = await recordLoginFailure(email, address);
      // `current?.id` distingue "senha errada" de "e-mail inexistente" na trilha,
      // sem que a resposta ao cliente diga qual dos dois foi.
      await recordAuthEvent({ ...trail, action: "login", outcome: "denied", userId: current?.id ?? null,
        reason: current ? "senha incorreta" : "e-mail sem conta" });
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
      await recordAuthEvent({ ...trail, action: "login", outcome: "denied", userId: current.id, reason: "sem associação a grupo" });
      return Response.json({ error: "Seu acesso ainda não foi liberado por um administrador." }, { status: 403 });
    }

    await clearLoginIdentityFailures(email, address);

    // Aplicativo Vinculato Campo: todas as verificações acima valem igual, e a
    // única diferença é a entrega da sessão — token na resposta em vez de
    // cookie. O app só serve a quem é membro de um grupo, por isso o
    // administrador de plataforma sem grupo não recebe token.
    if (body.client === "app") {
      if (!access) {
        await recordAuthEvent({ ...trail, action: "login", outcome: "denied", userId: current.id, reason: "sem associação a grupo" });
        return Response.json({ error: "O aplicativo de campo precisa de acesso a um grupo." }, { status: 403 });
      }
      const session = await createSessionToken(identity, { address, userAgent, deviceLabel: "Vinculato Campo · app" });
      await recordAuthEvent({ ...trail, action: "login", outcome: "success", userId: current.id });
      return Response.json(
        { ok: true, token: session.token, expiresAt: session.expiresAt, user: { name: current.name, email: current.email } },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    await setAuthSession(identity, { address, userAgent });
    await recordAuthEvent({ ...trail, action: "login", outcome: "success", userId: current.id });
    return Response.json({
      ok: true,
      redirectTo: platformAdmin && !access ? "/plataforma" : cleanReturnTo(body.returnTo),
    });
  } catch (error) {
    // Sem o objeto de erro inteiro: ele pode carregar o corpo com e-mail e senha.
    log("error", "auth.login_failed", { requestId: requestIdFrom(request), route: "/api/auth/login" }, { reason: error instanceof Error ? error.name : "unknown" });
    return Response.json({ error: "Não foi possível iniciar a sessão. Tente novamente." }, { status: 500 });
  }
}
