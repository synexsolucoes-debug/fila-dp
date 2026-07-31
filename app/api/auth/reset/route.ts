import { hashPassword } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { ensureSchema } from "@/lib/fila-dp-db";
import { hashRecoveryToken } from "@/lib/fila-dp-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { token?: string; password?: string; email?: string };
    const token = String(body.token ?? "").trim();
    const password = String(body.password ?? "");
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!token || token.length < 32) return Response.json({ error: "O link de recuperação é inválido ou incompleto." }, { status: 400 });
    if (password.length < 8 || password.length > 200) return Response.json({ error: "A senha deve ter entre 8 e 200 caracteres." }, { status: 400 });
    await ensureSchema();
    const d1 = getD1();
    const recovery = await d1.prepare(`SELECT rt.id, rt.user_id, u.email
      FROM fdp_access_recovery_tokens rt JOIN fdp_users u ON u.id = rt.user_id
      WHERE rt.token_hash = ? AND rt.used_at IS NULL AND datetime(rt.expires_at) > CURRENT_TIMESTAMP`)
      .bind(hashRecoveryToken(token))
      .first<{ id: string; user_id: string; email: string }>();
    if (!recovery || (email && recovery.email.toLowerCase() !== email)) return Response.json({ error: "Este link expirou, já foi usado ou não é válido." }, { status: 400 });
    const credentials = await hashPassword(password);
    await d1.batch([
      d1.prepare("UPDATE fdp_users SET password_hash = ?, password_salt = ? WHERE id = ?").bind(credentials.hash, credentials.salt, recovery.user_id),
      d1.prepare("UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?").bind(recovery.id),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Não foi possível redefinir a senha." }, { status: 500 });
  }
}
