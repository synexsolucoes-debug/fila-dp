import { getPlatformScopedD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { platformListLimit, sanitizePlatformValue } from "@/lib/platform-console";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

/**
 * Trilha de acesso, para quem administra a plataforma.
 *
 * Fica fora de `/api/platform/audit` de propósito: aquela rota percorre workspace
 * a workspace, porque a auditoria de negócio é por tenant. Evento de
 * autenticação não tem tenant — o login acontece antes de existir um, e a
 * tentativa recusada frequentemente não corresponde a conta alguma.
 *
 * Responde as duas perguntas de investigação de acesso: o que aconteceu com
 * esta conta, e o que aconteceu com este e-mail — inclusive quando ele nunca
 * foi conta nenhuma, que é o caso de quem está varrendo endereços.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const url = new URL(request.url);
    const email = cleanText(url.searchParams.get("email"), 200).toLowerCase();
    const action = cleanText(url.searchParams.get("action"), 40).toLowerCase();
    const outcome = cleanText(url.searchParams.get("outcome"), 20).toLowerCase();
    const limit = platformListLimit(url.searchParams.get("limit"), 50, 200);

    return await withPlatformContext(platform, async () => {
      // A leitura exige `app.platform_admin`, que `withPlatformContext` emite na
      // mesma transação. O workspace fica vazio: a tabela não tem tenant.
      const scoped = getPlatformScopedD1({ workspaceId: "", userId: platform.userId });
      const rows = await scoped.prepare(`SELECT event.id, event.user_id, event.email, event.action, event.outcome,
          event.reason, event.request_id, event.created_at, users.name AS user_name
        FROM fdp_auth_events event
        LEFT JOIN fdp_users users ON users.id = event.user_id
        WHERE ($1 = '' OR event.email LIKE '%' || $1 || '%')
          AND ($2 = '' OR event.action = $2)
          AND ($3 = '' OR event.outcome = $3)
        ORDER BY event.created_at DESC
        LIMIT $4`)
        .bind(email, action, outcome, limit)
        .all<Record<string, unknown>>();

      // Contagem de recusas recentes: é o número que denuncia varredura de
      // credencial antes de alguém reclamar.
      const denied = await scoped.prepare(`SELECT COUNT(*)::integer AS total
        FROM fdp_auth_events
        WHERE outcome = 'denied' AND action = 'login' AND created_at > now() - interval '24 hours'`)
        .first<{ total: number }>();

      return Response.json(sanitizePlatformValue({
        events: rows.results,
        deniedLoginsLast24h: Number(denied?.total ?? 0),
        // O hash de IP e de agente não sai daqui: ele serve para correlacionar
        // dentro do banco, não para ser exibido nem exportado.
      }), { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return apiError(error);
  }
}
