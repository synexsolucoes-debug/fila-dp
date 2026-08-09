import { clearAuthSession, type ChatGPTUser } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { getApiUser } from "@/lib/fila-dp-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" };

function persistedSession(user: ChatGPTUser): user is ChatGPTUser & { id: string; sessionId: string } {
  return Boolean(user.id && user.sessionId);
}

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  if (!persistedSession(auth.user)) {
    return Response.json({ error: "A gestão de sessões não está disponível para este tipo de acesso." }, { status: 409, headers: noStoreHeaders });
  }

  const rows = await getD1().prepare(`SELECT id, device_label, created_at, last_seen_at, expires_at
    FROM fdp_auth_sessions
    WHERE user_id = ?
      AND revoked_at IS NULL
      AND expires_at > CURRENT_TIMESTAMP
    ORDER BY last_seen_at DESC`)
    .bind(auth.user.id)
    .all<{ id: string; device_label: string; created_at: string; last_seen_at: string; expires_at: string }>();

  return Response.json({
    sessions: rows.results.map((session) => ({
      id: session.id,
      deviceLabel: session.device_label,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      expiresAt: session.expires_at,
      current: session.id === auth.user.sessionId,
    })),
  }, { headers: noStoreHeaders });
}

export async function DELETE(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  if (!persistedSession(auth.user)) {
    return Response.json({ error: "A gestão de sessões não está disponível para este tipo de acesso." }, { status: 409, headers: noStoreHeaders });
  }

  const scope = new URL(request.url).searchParams.get("scope") ?? "others";
  if (scope !== "others" && scope !== "all") {
    return Response.json({ error: "Escopo de revogação inválido." }, { status: 400, headers: noStoreHeaders });
  }

  if (scope === "others") {
    await getD1().prepare(`UPDATE fdp_auth_sessions
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`)
      .bind(auth.user.id, auth.user.sessionId)
      .run();
    return Response.json({ ok: true, signedOut: false }, { headers: noStoreHeaders });
  }

  await getD1().prepare(`UPDATE fdp_auth_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(auth.user.id)
    .run();
  await clearAuthSession();
  return Response.json({ ok: true, signedOut: true }, { headers: noStoreHeaders });
}
