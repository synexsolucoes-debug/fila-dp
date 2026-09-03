import { getD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { clientAddress, consumePublicAuthRateLimit } from "@/lib/auth-rate-limit";
import { recordAuthEvent } from "@/lib/auth-events";
import { assertTransactionalEmailConfigured, sendSignupConfirmationEmail } from "@/lib/email";
import { appBaseUrl, selfSignupEnabled } from "@/lib/saas";
import { createSignupConfirmationToken, normalizeSignupEmail, requireSelfSignupEnabled } from "@/lib/signup-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const accepted = () => Response.json({
  ok: true,
  message: "Se houver um cadastro pendente, enviaremos uma nova confirmação.",
}, { status: 202, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  try {
    requireSelfSignupEnabled(selfSignupEnabled());
    assertTransactionalEmailConfigured();
    const body = await request.json() as { email?: unknown };
    const email = normalizeSignupEmail(body.email);
    const address = clientAddress(request);
    const rateLimit = await consumePublicAuthRateLimit("resend", email, address);
    if (!rateLimit.allowed) {
      return Response.json({ error: "Muitas solicitações. Aguarde e tente novamente." }, {
        status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds), "Cache-Control": "no-store" },
      });
    }

    const confirmation = createSignupConfirmationToken();
    const pending = await getD1().prepare(`UPDATE fdp_signup_requests request SET
        token_hash = ?, token_expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE request.email = ? AND request.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM fdp_users user_account WHERE lower(user_account.email) = request.email)
      RETURNING request.id, request.name, request.email`)
      .bind(confirmation.hash, confirmation.expiresAt, email)
      .first<{ id: string; name: string; email: string }>();
    if (!pending) return accepted();

    const confirmationUrl = new URL("/api/auth/confirm", appBaseUrl(request));
    confirmationUrl.searchParams.set("token", confirmation.token);
    await sendSignupConfirmationEmail({
      to: pending.email,
      name: pending.name,
      confirmationUrl: confirmationUrl.toString(),
      idempotencyKey: `signup-resend-${pending.id}-${confirmation.hash.slice(0, 16)}`,
    });
    await recordAuthEvent({ action: "signup_confirmation_resent", outcome: "success", email, reason: "confirmação reenviada", address,
      userAgent: request.headers.get("user-agent") ?? "", requestId: request.headers.get("x-fila-dp-request-id") });
    return accepted();
  } catch (error) {
    return apiError(error);
  }
}
