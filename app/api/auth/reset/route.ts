import { hashPassword } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { classifyInfrastructureFault } from "@/lib/infrastructure-errors";
import { hashRecoveryToken } from "@/lib/fila-dp-recovery";
import { log } from "@/lib/observability";
import { recordAuthEvent } from "@/lib/auth-events";

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
    const d1 = getD1();
    const recovery = await d1.prepare(`SELECT rt.id, rt.user_id, u.email
      FROM fdp_access_recovery_tokens rt JOIN fdp_users u ON u.id = rt.user_id
      WHERE rt.token_hash = ? AND rt.used_at IS NULL AND rt.expires_at > CURRENT_TIMESTAMP`)
      .bind(hashRecoveryToken(token))
      .first<{ id: string; user_id: string; email: string }>();
    if (!recovery || (email && recovery.email.toLowerCase() !== email)) return Response.json({ error: "Este link expirou, já foi usado ou não é válido." }, { status: 400 });
    const credentials = await hashPassword(password);
    await d1.batch([
      d1.prepare("UPDATE fdp_users SET password_hash = ?, password_salt = ? WHERE id = ?").bind(credentials.hash, credentials.salt, recovery.user_id),
      // Queima todos os links pendentes do usuário, não só o que foi usado.
      // Quem pede recuperação três vezes deixa três links vivos na caixa de
      // e-mail; consumir um só mantinha os outros utilizáveis até expirarem,
      // então um e-mail antigo — ou um encaminhado por engano — ainda trocava a
      // senha depois que a conta já havia sido recuperada.
      d1.prepare("UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL")
        .bind(recovery.user_id),
      d1.prepare("UPDATE fdp_auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").bind(recovery.user_id),
    ]);
    // Redefinir senha derruba todas as sessões: quem investiga um acesso
    // indevido precisa ver o momento em que isso aconteceu.
    await recordAuthEvent({
      action: "password_reset", outcome: "success", email: recovery.email, userId: recovery.user_id,
      address: request.headers.get("x-forwarded-for") ?? "",
      userAgent: request.headers.get("user-agent") ?? "",
      requestId: request.headers.get("x-fila-dp-request-id"),
    });
    return Response.json({ ok: true });
  } catch (error) {
    // A mensagem interna do erro nunca pode chegar ao cliente aqui: esta rota é
    // pública e o texto de uma falha de banco entrega nome de tabela, de coluna
    // e de constraint a quem estiver sondando. Antes ela era devolvida crua.
    //
    // Falha de infraestrutura conhecida (banco atrás da versão, banco fora do
    // ar) já tem resposta própria, que diz o que houve sem expor SQL.
    if (classifyInfrastructureFault(error)) return apiError(error);

    // Para o resto, mensagem específica e acionável — não "não foi possível
    // concluir a operação" — com um requestId que liga o relato do usuário ao
    // log do servidor, onde o erro real fica.
    const requestId = crypto.randomUUID();
    log("error", "auth.password_reset_failed", { requestId }, {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
    });
    return Response.json(
      {
        error: "Não conseguimos redefinir sua senha agora. O link continua válido: tente novamente em alguns instantes ou solicite um novo em Recuperar acesso.",
        code: "PASSWORD_RESET_FAILED",
        requestId,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
