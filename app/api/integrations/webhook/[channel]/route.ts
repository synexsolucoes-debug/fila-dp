import { timingSafeEqual } from "node:crypto";
import { getD1 } from "@/db";
import { apiError, text } from "@/lib/fila-dp-api";
import { recordActivity } from "@/lib/fila-dp-db";
import { parseWorkspaceWebhookSecrets } from "@/lib/integration-security";

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

    const d1 = getD1();
    const workspace = await d1.prepare("SELECT id FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first<{ id: string }>();
    if (!workspace) return Response.json({ error: "Workspace não encontrado." }, { status: 404 });
    const integration = await d1.prepare("SELECT id, status FROM fdp_integrations WHERE workspace_id = ? AND channel = ?").bind(workspaceId, channel).first<{ id: string; status: string }>();
    if (!integration) return Response.json({ error: "Integração não configurada." }, { status: 409 });
    if (integration.status === "paused") return Response.json({ error: "Integração pausada." }, { status: 409 });

    const secretKey = `FDP_${channel.toUpperCase()}_WEBHOOK_SECRET`;
    const workspaceSecrets = parseWorkspaceWebhookSecrets(process.env[`${secretKey}S`]);
    let expectedSecret = workspaceSecrets[workspaceId] ?? "";

    // Keep the existing single-workspace Power Automate flow operational. As
    // soon as more than one active workspace uses the channel, each workspace
    // must have its own secret in FDP_<CHANNEL>_WEBHOOK_SECRETS.
    if (!expectedSecret) {
      const activeIntegrations = await d1.prepare("SELECT COUNT(*) AS value FROM fdp_integrations WHERE channel = ? AND status IN ('connected', 'error')").bind(channel).first<{ value: number }>();
      const legacySecretIsBoundToThisWorkspace = ["connected", "error"].includes(integration.status)
        && Number(activeIntegrations?.value ?? 0) === 1;
      if (legacySecretIsBoundToThisWorkspace) expectedSecret = String(process.env[secretKey] ?? "");
    }

    const receivedSecret = request.headers.get("x-fila-dp-secret") ?? request.headers.get("x-webhook-secret") ?? "";
    if (!secretMatches(receivedSecret, expectedSecret)) return Response.json({ error: "Webhook não autorizado." }, { status: 401 });

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
    if (externalId) {
      const escapedExternalId = externalId.replace(/[\\%_]/g, "\\$&");
      const duplicate = await d1.prepare("SELECT id FROM fdp_workspace_inbox_items WHERE workspace_id = ? AND body LIKE ? ESCAPE '\\' LIMIT 1").bind(workspaceId, `%[external:${escapedExternalId}]%`).first();
      if (duplicate) return Response.json({ accepted: true, duplicate: true, inboxId: duplicate.id });
    }

    const inboxId = crypto.randomUUID();
    const taggedBody = externalId ? `${body}\n\n[external:${externalId}]` : body;
    await d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status) VALUES (?, ?, ?, ?, ?, ?, 'new')").bind(inboxId, workspaceId, channel, senderName, subject, taggedBody).run();
    await d1.prepare("UPDATE fdp_integrations SET last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, status = 'connected', updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND channel = ?").bind(workspaceId, channel).run();
    await recordActivity(workspaceId, null, `integration:${channel}`, "inbox.webhook_received", { channel, inboxId, externalId: externalId || null });
    return Response.json({ accepted: true, inboxId }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
