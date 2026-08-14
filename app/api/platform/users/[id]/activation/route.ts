import { getD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { createRecoveryToken } from "@/lib/fila-dp-recovery";
import { requiredPlatformReason } from "@/lib/platform-console";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";

type RouteContext = { params: Promise<{ id: string }> };

/** Gera um link de uso único para uma identidade ainda sem senha. */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    if (body.confirmed !== true) {
      throw ApiError.badRequest("Confirme explicitamente a geração do link de ativação.", "PLATFORM_CONFIRMATION_REQUIRED");
    }
    const reason = requiredPlatformReason(body.reason);

    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const user = await d1.prepare(`SELECT id, email, name, status,
          (password_hash IS NOT NULL AND password_hash <> '') AS is_activated
        FROM fdp_users WHERE id = ?`).bind(id).first<{ id: string; email: string; name: string; status: string; is_activated: boolean | number | string }>();
      if (!user) throw ApiError.notFound("Usuário não encontrado.", "USER_NOT_FOUND");
      if (user.status === "blocked") {
        throw new ApiError(409, "USER_BLOCKED", "Desbloqueie a identidade antes de gerar o link de ativação.");
      }
      const activated = user.is_activated === true || user.is_activated === 1 || user.is_activated === "t" || user.is_activated === "true";
      if (activated) {
        throw new ApiError(409, "USER_ALREADY_ACTIVATED", "Esta identidade já concluiu a ativação.");
      }

      const { token, hash } = createRecoveryToken();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const requestId = request.headers.get("x-fila-dp-request-id") ?? "";
      await d1.batch([
        d1.prepare("UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").bind(user.id),
        d1.prepare("INSERT INTO fdp_access_recovery_tokens (id, user_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), user.id, hash, platform.email, expiresAt),
        d1.prepare(`INSERT INTO fdp_platform_audit_events
            (id, actor_user_id, actor_email, action, entity_type, entity_id, after_json, request_id)
          VALUES (?, ?, ?, 'platform.user_activation_link_created', 'user', ?, ?::jsonb, ?)`)
          .bind(crypto.randomUUID(), platform.userId, platform.email, user.id,
            JSON.stringify({ email: user.email, expiresAt, reason }), requestId),
      ]);

      const activationUrl = new URL("/recuperar", request.url);
      activationUrl.searchParams.set("token", token);
      activationUrl.searchParams.set("email", user.email);
      return Response.json({
        activation: { url: activationUrl.toString(), expiresAt, name: user.name },
      }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return apiError(error);
  }
}
