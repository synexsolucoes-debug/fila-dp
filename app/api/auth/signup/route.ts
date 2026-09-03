import { hashPassword } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { clientAddress, consumePublicAuthRateLimit } from "@/lib/auth-rate-limit";
import { recordAuthEvent } from "@/lib/auth-events";
import { assertTransactionalEmailConfigured, sendSignupConfirmationEmail } from "@/lib/email";
import { appBaseUrl, selfSignupEnabled, workspaceSlug } from "@/lib/saas";
import {
  cleanSignupName,
  createSignupConfirmationToken,
  createSignupProvisioningIds,
  normalizeSignupEmail,
  requireLegalAcceptance,
  requireSelfSignupEnabled,
  signupRequestFingerprint,
  validateSignupPassword,
} from "@/lib/signup-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  name?: unknown;
  email?: unknown;
  password?: unknown;
  workspaceName?: unknown;
  acceptTerms?: unknown;
  acceptPrivacy?: unknown;
};

const acceptedResponse = () => Response.json({
  ok: true,
  message: "Se os dados puderem ser usados, enviaremos um link de confirmação para o e-mail informado.",
}, { status: 202, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  try {
    requireSelfSignupEnabled(selfSignupEnabled());
    assertTransactionalEmailConfigured();
    const body = await request.json() as Body;
    const email = normalizeSignupEmail(body.email);
    const password = validateSignupPassword(body.password);
    const name = cleanSignupName(body.name, "person");
    const workspaceName = cleanSignupName(body.workspaceName, "workspace");
    const legal = requireLegalAcceptance(body.acceptTerms, body.acceptPrivacy);
    const address = clientAddress(request);
    const rateLimit = await consumePublicAuthRateLimit("signup", email, address);
    if (!rateLimit.allowed) {
      return Response.json(
        { error: "Muitas solicitações de cadastro. Aguarde e tente novamente." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds), "Cache-Control": "no-store" } },
      );
    }

    // O custo da senha é pago antes de descobrir se a conta existe, reduzindo
    // diferença observável entre identidade nova e já cadastrada.
    const passwordRecord = await hashPassword(password);
    const confirmation = createSignupConfirmationToken();
    const d1 = getD1();
    const existingUser = await d1.prepare("SELECT 1 AS found FROM fdp_users WHERE lower(email) = ?").bind(email).first();
    if (existingUser) {
      await recordAuthEvent({ action: "signup_requested", outcome: "denied", email, reason: "identidade existente", address,
        userAgent: request.headers.get("user-agent") ?? "", requestId: request.headers.get("x-fila-dp-request-id") });
      return acceptedResponse();
    }

    const provision = createSignupProvisioningIds();
    const acceptedAt = new Date().toISOString();
    const pending = await d1.prepare(`INSERT INTO fdp_signup_requests
        (id, email, name, password_hash, password_salt, workspace_name, workspace_slug,
         provisioned_user_id, provisioned_workspace_id, provisioned_board_id,
         token_hash, token_expires_at, terms_version, privacy_version,
         terms_accepted_at, privacy_accepted_at, status, request_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt,
        workspace_name = EXCLUDED.workspace_name, workspace_slug = EXCLUDED.workspace_slug,
        token_hash = EXCLUDED.token_hash, token_expires_at = EXCLUDED.token_expires_at,
        terms_version = EXCLUDED.terms_version, privacy_version = EXCLUDED.privacy_version,
        terms_accepted_at = EXCLUDED.terms_accepted_at, privacy_accepted_at = EXCLUDED.privacy_accepted_at,
        request_fingerprint = EXCLUDED.request_fingerprint, updated_at = CURRENT_TIMESTAMP
      WHERE fdp_signup_requests.status = 'pending'
      RETURNING id, name, email`)
      .bind(
        provision.requestId, email, name, passwordRecord.hash, passwordRecord.salt, workspaceName, workspaceSlug(workspaceName),
        provision.userId, provision.workspaceId, provision.boardId,
        confirmation.hash, confirmation.expiresAt, legal.termsVersion, legal.privacyVersion,
        acceptedAt, acceptedAt, signupRequestFingerprint(email, address),
      ).first<{ id: string; name: string; email: string }>();

    if (!pending) return acceptedResponse();
    const confirmationUrl = new URL("/api/auth/confirm", appBaseUrl(request));
    confirmationUrl.searchParams.set("token", confirmation.token);
    await sendSignupConfirmationEmail({
      to: pending.email,
      name: pending.name,
      confirmationUrl: confirmationUrl.toString(),
      idempotencyKey: `signup-${pending.id}-${confirmation.hash.slice(0, 16)}`,
    });
    await recordAuthEvent({ action: "signup_requested", outcome: "success", email, reason: "confirmação enviada", address,
      userAgent: request.headers.get("user-agent") ?? "", requestId: request.headers.get("x-fila-dp-request-id") });
    return acceptedResponse();
  } catch (error) {
    return apiError(error);
  }
}
