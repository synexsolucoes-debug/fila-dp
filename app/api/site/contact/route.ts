import { createHmac } from "node:crypto";
import { getD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { clientAddress } from "@/lib/auth-rate-limit";
import { sanitizeLead } from "@/lib/marketing";
import { log, requestIdFrom } from "@/lib/observability";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

const WINDOW_SECONDS = 3600;
const ADDRESS_LIMIT = 5;

function limiterSecret() {
  const secret = process.env.FDP_AUTH_SECRET;
  if (!secret) throw new Error("FDP_AUTH_SECRET não configurado.");
  return secret;
}

/**
 * Recebe o contato do site comercial.
 *
 * O formulário grava um registro de verdade: o botão não é decorativo. O
 * conteúdo é validado, o consentimento é obrigatório e o endereço tem limite
 * por hora para o formulário não virar canal de abuso.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > 8192) throw new ApiError(413, "REQUEST_TOO_LARGE", "Mensagem muito longa.");

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const lead = sanitizeLead(body);
    const sourcePath = cleanText(body.sourcePath, 120);

    const d1 = getD1();
    const keyHash = createHmac("sha256", limiterSecret()).update(`lead:${clientAddress(request)}`).digest("base64url");
    const limit = await d1.prepare(`INSERT INTO fdp_api_rate_limits (key_hash, window_started_at, request_count, updated_at)
      VALUES (?, now(), 1, now())
      ON CONFLICT (key_hash) DO UPDATE SET
        window_started_at = CASE WHEN fdp_api_rate_limits.window_started_at < now() - (? * interval '1 second') THEN now() ELSE fdp_api_rate_limits.window_started_at END,
        request_count = CASE WHEN fdp_api_rate_limits.window_started_at < now() - (? * interval '1 second') THEN 1 ELSE fdp_api_rate_limits.request_count + 1 END,
        updated_at = now()
      RETURNING request_count`)
      .bind(keyHash, WINDOW_SECONDS, WINDOW_SECONDS)
      .first<{ request_count: number }>();

    if (Number(limit?.request_count ?? 1) > ADDRESS_LIMIT) {
      log("warn", "site.contact_rate_limited", { requestId }, { limit: ADDRESS_LIMIT });
      throw new ApiError(429, "CONTACT_RATE_LIMITED", "Muitos envios em pouco tempo. Tente novamente mais tarde.");
    }

    const id = crypto.randomUUID();
    await d1.prepare(`INSERT INTO fdp_marketing_leads (id, name, email, company, phone, headcount, interest, message, source_path, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, lead.name, lead.email, lead.company, lead.phone, lead.headcount, lead.interest, lead.message, sourcePath, requestId)
      .run();

    // O log registra que houve contato, sem transportar nome, e-mail ou mensagem.
    log("info", "site.contact_received", { requestId }, { interest: lead.interest, hasCompany: Boolean(lead.company) });

    return Response.json(
      { received: true, protocol: id.slice(0, 8).toUpperCase() },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
