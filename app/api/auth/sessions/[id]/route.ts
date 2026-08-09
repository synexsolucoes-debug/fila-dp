import { clearAuthSession } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { getApiUser } from "@/lib/fila-dp-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" };
type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  if (!auth.user.id || !auth.user.sessionId) {
    return Response.json({ error: "A gestão de sessões não está disponível para este tipo de acesso." }, { status: 409, headers: noStoreHeaders });
  }

  const { id } = await context.params;
  const owned = await getD1().prepare(`SELECT id
    FROM fdp_auth_sessions
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`)
    .bind(id, auth.user.id)
    .first<{ id: string }>();
  if (!owned) {
    return Response.json({ error: "Sessão não encontrada." }, { status: 404, headers: noStoreHeaders });
  }

  if (id === auth.user.sessionId) {
    await clearAuthSession();
    return Response.json({ ok: true, signedOut: true }, { headers: noStoreHeaders });
  }

  await getD1().prepare(`UPDATE fdp_auth_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .bind(id, auth.user.id)
    .run();
  return Response.json({ ok: true, signedOut: false }, { headers: noStoreHeaders });
}
