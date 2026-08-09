import { createHash, timingSafeEqual } from "node:crypto";
import { getD1 } from "@/db";
import { apiError, text } from "@/lib/fila-dp-api";
import { recordActivity } from "@/lib/fila-dp-db";
import { parseWorkspaceWebhookSecrets } from "@/lib/integration-security";
import { setTenantContext } from "@/lib/tenant-context";

type RouteContext = { params: Promise<{ channel: string }> };

function messageText(value: unknown, max = 5000): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const nested = record.content ?? record.text ?? record.plainText ?? record.value ?? record.body;
  if (typeof nested === "string") {
    // Teams may send HTML in the message body. Keep the Inbox readable while
    // still accepting the structured payload returned by Power Automate.
    return nested.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }
  return "";
}

function secretMatches(received: string, expected: string) {
  if (!received || !expected) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { channel: rawChannel } = await context.params;
    const channel = rawChannel.toLowerCase();
    if (!["email", "whatsapp", "teams"].includes(channel)) return Response.json({ error: "Canal não suportado." }, { status: 404 });

    const url = new URL(request.url);
    const workspaceId = text(url.searchParams.get("workspaceId"), 100);
    if (!workspaceId) return Response.json({ error: "workspaceId obrigatório." }, { status: 400 });

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024) {
      return Response.json({ error: "Payload do webhook excede 64 KB." }, { status: 413 });
    }

    const preAuthSecretKey = `FDP_${channel.toUpperCase()}_WEBHOOK_SECRET`;
    // Multi-tenant deployments use FDP_<CHANNEL>_WEBHOOK_SECRETS.
    const preAuthWorkspaceSecrets = parseWorkspaceWebhookSecrets(process.env[`${preAuthSecretKey}S`]);
    const preAuthLegacyWorkspaceId = String(process.env[`${preAuthSecretKey}_WORKSPACE_ID`] ?? "");
    const preAuthExpectedSecret = preAuthWorkspaceSecrets[workspaceId]
      ?? (preAuthLegacyWorkspaceId === workspaceId ? String(process.env[preAuthSecretKey] ?? "") : "");
    const preAuthReceivedSecret = request.headers.get("x-fila-dp-secret") ?? request.headers.get("x-webhook-secret") ?? "";
    if (!secretMatches(preAuthReceivedSecret, preAuthExpectedSecret)) {
      return Response.json({ error: "Webhook não autorizado." }, { status: 401 });
    }

    setTenantContext({ workspaceId, userId: null });

    const d1 = getD1();
    const workspace = await d1.prepare("SELECT id FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first<{ id: string }>();
    if (!workspace) return Response.json({ error: "Workspace não encontrado." }, { status: 404 });
    const integration = await d1.prepare("SELECT id, status FROM fdp_integrations WHERE workspace_id = ? AND channel = ?").bind(workspaceId, channel).first<{ id: string; status: string }>();
    if (!integration) return Response.json({ error: "Integração não configurada." }, { status: 409 });
    if (integration.status === "paused") return Response.json({ error: "Integração pausada." }, { status: 409 });

    const rawPayload = await request.text();
    if (new TextEncoder().encode(rawPayload).byteLength > 64 * 1024) {
      return Response.json({ error: "Payload do webhook excede 64 KB." }, { status: 413 });
    }
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      payload = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Payload JSON inválido." }, { status: 400 });
    }

    const senderName = text(payload.senderName ?? payload.from ?? payload.sender, 160) || "Solicitante externo";
    const subject = text(payload.subject ?? payload.title ?? payload.event, 240) || `Solicitação via ${channel}`;
    const body = messageText(payload.body ?? payload.text ?? payload.message, 5000);
    if (!body) return Response.json({ error: "Mensagem vazia." }, { status: 400 });

    const externalId = text(payload.externalId ?? payload.messageId ?? payload.id, 180);
    const payloadHash = createHash("sha256").update(rawPayload).digest("hex");
    const idempotencyKey = `webhook:${channel}:${externalId || payloadHash}`;
    const inboxId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const accepted = await d1.prepare(`WITH inserted_run AS (
        INSERT INTO fdp_integration_sync_runs
          (id, workspace_id, integration_id, trigger_type, status, idempotency_key, received_count, processed_count, started_at, completed_at)
        VALUES (?, ?, ?, 'webhook', 'succeeded', ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING RETURNING id
      ), inserted_item AS (
        INSERT INTO fdp_integration_sync_items
          (id, workspace_id, integration_id, run_id, item_key, external_id, direction, status, payload_hash, target_type, target_id, metadata_json, processed_at)
        SELECT ?, ?, ?, inserted_run.id, ?, ?, 'inbound', 'processed', ?, 'inbox', ?, ?::jsonb, CURRENT_TIMESTAMP FROM inserted_run
        RETURNING id
      ), inserted_inbox AS (
        INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status)
        SELECT ?, ?, ?, ?, ?, ?, 'new' FROM inserted_item RETURNING id
      ) SELECT id FROM inserted_inbox`)
      .bind(runId, workspaceId, integration.id, idempotencyKey, itemId, workspaceId, integration.id, idempotencyKey, externalId, payloadHash, inboxId,
        JSON.stringify({ source: "signed_webhook", externalIdProvided: Boolean(externalId) }), inboxId, workspaceId, channel, senderName, subject, body)
      .first<{ id: string }>();
    if (!accepted) {
      const duplicate = await d1.prepare(`SELECT item.target_id AS id FROM fdp_integration_sync_runs run
        JOIN fdp_integration_sync_items item ON item.workspace_id = run.workspace_id AND item.run_id = run.id
        WHERE run.workspace_id = ? AND run.integration_id = ? AND run.idempotency_key = ? LIMIT 1`).bind(workspaceId, integration.id, idempotencyKey).first<{ id: string }>();
      return Response.json({ accepted: true, duplicate: true, inboxId: duplicate?.id ?? null });
    }
    await d1.prepare("UPDATE fdp_integrations SET last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, status = 'connected', updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND channel = ?").bind(workspaceId, channel).run();
    await recordActivity(workspaceId, null, `integration:${channel}`, "inbox.webhook_received", { channel, inboxId, externalId: externalId || null });
    return Response.json({ accepted: true, inboxId }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
