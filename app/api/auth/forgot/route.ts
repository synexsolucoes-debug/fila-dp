import { getD1 } from "@/db";
import { sendTransactionalEmail } from "@/lib/fila-dp-email";
import { createRecoveryToken } from "@/lib/fila-dp-recovery";
import { assertAuthAttemptAllowed, AuthRateLimitError, authRateLimitResponse, registerAuthFailure } from "@/lib/fila-dp-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: unknown };
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Informe um e-mail válido." }, { status: 400 });
    const rateLimitKey = await assertAuthAttemptAllowed(request, email, "forgot-password");
    await registerAuthFailure(rateLimitKey);

    const d1 = getD1();
    const user = await d1.prepare(`SELECT u.id, u.name
      FROM fdp_users u
      WHERE u.email = ? AND u.password_hash IS NOT NULL
        AND EXISTS (SELECT 1 FROM fdp_workspace_members wm WHERE wm.user_id = u.id)
      LIMIT 1`).bind(email).first<{ id: string; name: string }>();

    if (user) {
      const { token, hash } = createRecoveryToken();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await d1.batch([
        d1.prepare("UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").bind(user.id),
        d1.prepare("INSERT INTO fdp_access_recovery_tokens (id, user_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, 'self-service', ?)").bind(crypto.randomUUID(), user.id, hash, expiresAt),
      ]);
      const recoveryUrl = new URL("/recuperar", process.env.FDP_PUBLIC_URL || request.url);
      recoveryUrl.searchParams.set("token", token);
      recoveryUrl.searchParams.set("email", email);
      const delivery = await sendTransactionalEmail({
        to: email,
        subject: "Recupere seu acesso ao Fila DP",
        preheader: "Seu link seguro para definir uma nova senha.",
        title: `Olá, ${user.name}.`,
        paragraphs: ["Recebemos uma solicitação para redefinir sua senha no Fila DP.", "O link expira em 30 minutos e só pode ser utilizado uma vez."],
        actionLabel: "Definir nova senha",
        actionUrl: recoveryUrl.toString(),
        idempotencyKey: `password-recovery-${user.id}-${hash.slice(0, 16)}`,
      });
      if (delivery.status === "failed") console.error("[fila-dp][email] password-recovery", { email, error: delivery.error });
    }

    return Response.json({ accepted: true, message: "Se o e-mail estiver liberado, você receberá um link de recuperação." }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthRateLimitError) return authRateLimitResponse(error);
    console.error("[fila-dp][auth] forgot-password", { error: error instanceof Error ? error.message : String(error) });
    return Response.json({ accepted: true, message: "Se o e-mail estiver liberado, você receberá um link de recuperação." }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
}
