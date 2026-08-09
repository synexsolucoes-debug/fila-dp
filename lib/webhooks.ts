import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { getD1 } from "@/db";
import { ApiError } from "./api-errors.ts";
import { currentVaultKey, vaultKeyByVersion } from "./integrations.ts";
import { log } from "./observability.ts";
import { cleanText } from "./registrations.ts";

type Database = ReturnType<typeof getD1>;

export const SIGNATURE_HEADER = "x-fila-dp-signature";
export const EVENT_ID_HEADER = "x-fila-dp-event-id";
export const EVENT_TYPE_HEADER = "x-fila-dp-event-type";
export const DELIVERY_ID_HEADER = "x-fila-dp-delivery-id";
export const ATTEMPT_HEADER = "x-fila-dp-attempt";

/** Janela aceita pelo receptor para rejeitar replay (§93). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_RESPONSE_SNIPPET = 500;
const LEASE_SECONDS = 60;

/**
 * Assinatura de saída: HMAC-SHA256 sobre `<timestamp>.<corpo>`.
 *
 * O timestamp entra no material assinado justamente para que o receptor possa
 * recusar entregas antigas — assinar só o corpo permitiria replay indefinido.
 */
export function signPayload(secret: string, timestamp: number, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, timestamp: number, body: string) {
  return `t=${timestamp},v1=${signPayload(secret, timestamp, body)}`;
}

/** Verificação em tempo constante, para o receptor e para os testes. */
export function verifySignature(input: { secret: string; header: string; body: string; nowSeconds?: number }) {
  const match = /^t=(\d{1,15}),v1=([a-f0-9]{64})$/u.exec(input.header.trim());
  if (!match) return { valid: false, reason: "malformed" as const };
  const timestamp = Number(match[1]);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return { valid: false, reason: "expired" as const };
  const expected = Buffer.from(signPayload(input.secret, timestamp, input.body), "hex");
  const received = Buffer.from(match[2], "hex");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { valid: false, reason: "mismatch" as const };
  }
  return { valid: true, reason: "ok" as const };
}

/** Backoff exponencial com teto, igual ao motor de integrações. */
export function deliveryDelaySeconds(attempt: number) {
  return Math.min(3600, 30 * Math.pow(2, Math.max(0, attempt - 1)));
}

/* -------------------------------------------------------------------------- */
/* Segredo do endpoint                                                         */
/* -------------------------------------------------------------------------- */

export function generateWebhookSecret() {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function sealWebhookSecret(secret: string) {
  if (secret.length < 24) throw ApiError.badRequest("Segredo do webhook inválido.", "WEBHOOK_SECRET_INVALID");
  const { key, version } = currentVaultKey();
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  cipher.setAAD(Buffer.from(`fila-dp:webhook:v${version}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    encryptedValue: encrypted.toString("base64"),
    initializationVector: initializationVector.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: version,
  };
}

export function openWebhookSecret(sealed: { encryptedValue: string; initializationVector: string; authTag: string; keyVersion: number }) {
  const key = vaultKeyByVersion(sealed.keyVersion);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.initializationVector, "base64"));
    decipher.setAAD(Buffer.from(`fila-dp:webhook:v${sealed.keyVersion}`, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.encryptedValue, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError(500, "WEBHOOK_SECRET_DECRYPTION_FAILED", "Não foi possível abrir o segredo do webhook.");
  }
}

/* -------------------------------------------------------------------------- */
/* Destino                                                                     */
/* -------------------------------------------------------------------------- */

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

/** Só HTTPS e nunca rede interna: um webhook de saída não vira SSRF. */
export function validateWebhookUrl(value: unknown) {
  const raw = cleanText(value, 500);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest("Informe uma URL HTTPS válida.", "WEBHOOK_URL_INVALID");
  }
  if (url.protocol !== "https:") throw ApiError.badRequest("O endpoint precisa usar HTTPS.", "WEBHOOK_URL_INSECURE");
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1"
    || host.startsWith("fe80:") || (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd")))
    || isPrivateIpv4(host)) {
    throw ApiError.badRequest("O endpoint não pode apontar para a rede interna.", "WEBHOOK_URL_PRIVATE");
  }
  if (url.username || url.password) throw ApiError.badRequest("Não use credenciais na URL do endpoint.", "WEBHOOK_URL_CREDENTIALS");
  url.hash = "";
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Entrega                                                                     */
/* -------------------------------------------------------------------------- */

type DeliveryRow = {
  id: string; endpoint_id: string; event_id: string; event_type: string; attempt: number; max_attempts: number;
  url: string; secret_encrypted: string; secret_iv: string; secret_tag: string; secret_key_version: number;
  payload_json: Record<string, unknown> | string; occurred_at: string; entity_type: string; entity_id: string;
};

export function deliveryBody(input: {
  deliveryId: string; eventId: string; eventType: string; entityType: string; entityId: string;
  occurredAt: string; workspaceId: string; payload: Record<string, unknown>;
}) {
  return JSON.stringify({
    id: input.eventId,
    deliveryId: input.deliveryId,
    type: input.eventType,
    workspaceId: input.workspaceId,
    entity: { type: input.entityType, id: input.entityId },
    occurredAt: input.occurredAt,
    data: input.payload,
  });
}

/**
 * Processa uma entrega pendente com lease, para que dois executores
 * concorrentes nunca disparem o mesmo webhook duas vezes.
 */
export async function processNextWebhookDelivery(d1: Database, workspaceId: string) {
  const leaseToken = crypto.randomUUID();
  const claimed = await d1.prepare(`WITH candidate AS (
      SELECT id FROM fdp_webhook_deliveries
      WHERE workspace_id = ? AND status IN ('pending', 'failed') AND next_attempt_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE fdp_webhook_deliveries d SET status = 'delivering', lease_token = ?, lease_expires_at = now() + interval '${LEASE_SECONDS} seconds',
      attempt = d.attempt + 1, updated_at = now()
    FROM candidate WHERE d.id = candidate.id AND d.workspace_id = ?
    RETURNING d.id`)
    .bind(workspaceId, leaseToken, workspaceId)
    .first<{ id: string }>();
  if (!claimed) return null;

  const delivery = await d1.prepare(`SELECT d.id, d.endpoint_id, d.event_id, d.event_type, d.attempt, d.max_attempts,
      e.url, e.secret_encrypted, e.secret_iv, e.secret_tag, e.secret_key_version,
      v.payload_json, v.occurred_at, v.entity_type, v.entity_id
    FROM fdp_webhook_deliveries d
    JOIN fdp_webhook_endpoints e ON e.workspace_id = d.workspace_id AND e.id = d.endpoint_id
    JOIN fdp_domain_events v ON v.workspace_id = d.workspace_id AND v.id = d.event_id
    WHERE d.workspace_id = ? AND d.id = ? AND d.lease_token = ?`)
    .bind(workspaceId, claimed.id, leaseToken).first<DeliveryRow>();
  if (!delivery) return null;

  const payload = typeof delivery.payload_json === "string"
    ? JSON.parse(delivery.payload_json) as Record<string, unknown>
    : delivery.payload_json;
  const body = deliveryBody({
    deliveryId: String(delivery.id),
    eventId: String(delivery.event_id),
    eventType: String(delivery.event_type),
    entityType: String(delivery.entity_type),
    entityId: String(delivery.entity_id),
    occurredAt: new Date(delivery.occurred_at).toISOString(),
    workspaceId,
    payload,
  });
  const secret = openWebhookSecret({
    encryptedValue: String(delivery.secret_encrypted),
    initializationVector: String(delivery.secret_iv),
    authTag: String(delivery.secret_tag),
    keyVersion: Number(delivery.secret_key_version),
  });
  const timestamp = Math.floor(Date.now() / 1000);

  let responseStatus = 0;
  let snippet = "";
  let errorCode = "";
  try {
    const response = await fetch(String(delivery.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "FilaDP-Webhooks/1",
        [SIGNATURE_HEADER]: signatureHeader(secret, timestamp, body),
        [EVENT_ID_HEADER]: String(delivery.event_id),
        [EVENT_TYPE_HEADER]: String(delivery.event_type),
        [DELIVERY_ID_HEADER]: String(delivery.id),
        [ATTEMPT_HEADER]: String(delivery.attempt),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = response.status;
    snippet = (await response.text().catch(() => "")).slice(0, MAX_RESPONSE_SNIPPET);
    if (!response.ok) errorCode = `HTTP_${response.status}`;
  } catch (error) {
    errorCode = error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR";
  }

  const delivered = !errorCode;
  const exhausted = !delivered && delivery.attempt >= delivery.max_attempts;
  const nextStatus = delivered ? "delivered" : exhausted ? "dead_letter" : "failed";

  await d1.batch([
    d1.prepare(`UPDATE fdp_webhook_deliveries SET status = ?, response_status = ?, response_snippet = ?, error_code = ?,
        delivered_at = CASE WHEN ? = 'delivered' THEN now() ELSE delivered_at END,
        next_attempt_at = CASE WHEN ? = 'failed' THEN now() + (? * interval '1 second') ELSE next_attempt_at END,
        lease_token = '', lease_expires_at = NULL, updated_at = now()
      WHERE workspace_id = ? AND id = ?`)
      .bind(nextStatus, responseStatus, snippet, errorCode, nextStatus, nextStatus,
        deliveryDelaySeconds(delivery.attempt), workspaceId, delivery.id),
    d1.prepare(`UPDATE fdp_webhook_endpoints SET
        failure_count = CASE WHEN ? THEN 0 ELSE failure_count + 1 END,
        last_delivery_at = CASE WHEN ? THEN now() ELSE last_delivery_at END,
        last_failure_at = CASE WHEN ? THEN last_failure_at ELSE now() END,
        updated_at = now()
      WHERE workspace_id = ? AND id = ?`)
      .bind(delivered, delivered, delivered, workspaceId, delivery.endpoint_id),
  ]);

  log(delivered ? "info" : "warn", "webhook.delivery", {
    workspaceId, deliveryId: String(delivery.id),
  }, {
    eventType: String(delivery.event_type),
    attempt: delivery.attempt,
    status: nextStatus,
    responseStatus,
    errorCode: errorCode || undefined,
  });

  return { id: String(delivery.id), status: nextStatus, attempt: delivery.attempt, responseStatus, errorCode };
}
