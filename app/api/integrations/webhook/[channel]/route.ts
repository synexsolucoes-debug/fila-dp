import { createHmac, timingSafeEqual } from "node:crypto";
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

function whatsappSignatureMatches(rawPayload: string, signature: string) {
  const appSecret = process.env.FDP_WHATSAPP_APP_SECRET ?? "";
  if (!appSecret || !signature.startsWith("sha256=")) return false;
  return secretMatches(signature.slice(7), createHmac("sha256", appSecret).update(rawPayload).digest("hex"));
}

function metaWhatsappValues(payload: Record<string, unknown>) {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  return entries.flatMap((rawEntry) => {
    const entry = rawEntry && typeof rawEntry === "object" ? rawEntry as Record<string, unknown> : {};
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    return changes.flatMap((rawChange) => {
      const change = rawChange && typeof rawChange === "object" ? rawChange as Record<string, unknown> : {};
      return change.value && typeof change.value === "object" ? [change.value as Record<string, unknown>] : [];
    });
  });
}

function metaWhatsappMessages(payload: Record<string, unknown>) {
  return metaWhatsappValues(payload).flatMap((value) => {
    const contacts = Array.isArray(value.contacts) ? value.contacts as Array<Record<string, unknown>> : [];
    const contactNames = new Map(contacts.map((contact) => {
      const profile = contact.profile && typeof contact.profile === "object" ? contact.profile as Record<string, unknown> : {};
      return [text(contact.wa_id, 80), text(profile.name, 160)];
    }));
    const messages = Array.isArray(value.messages) ? value.messages : [];
    return messages.flatMap((rawMessage) => {
      if (!rawMessage || typeof rawMessage !== "object") return [];
      const message = rawMessage as Record<string, unknown>;
      const from = text(message.from, 80);
      const interactive = message.interactive && typeof message.interactive === "object" ? message.interactive as Record<string, unknown> : {};
      const buttonReply = interactive.button_reply && typeof interactive.button_reply === "object" ? interactive.button_reply as Record<string, unknown> : {};
      const listReply = interactive.list_reply && typeof interactive.list_reply === "object" ? interactive.list_reply as Record<string, unknown> : {};
      const media = [message.image, message.document, message.audio, message.video, message.sticker].find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
      return [{
        senderName: contactNames.get(from) || from || "Contato do WhatsApp",
        subject: "Mensagem via WhatsApp",
        body: messageText(message.text ?? message.button ?? buttonReply.title ?? listReply.title ?? media?.caption, 5000) || `[${text(message.type, 40) || "mensagem"} recebida pelo WhatsApp]`,
        externalId: text(message.id, 180),
      }];
    });
  });
}

function metaWhatsappPhoneIds(payload: Record<string, unknown>) {
  return metaWhatsappValues(payload).map((value) => {
    const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : {};
    return text(metadata.phone_number_id, 120);
  }).filter(Boolean);
}

export async function GET(request: Request, context: RouteContext) {
  const { channel } = await context.params;
  if (channel.toLowerCase() !== "whatsapp") return Response.json({ error: "Canal não suportado." }, { status: 404 });
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode === "subscribe" && secretMatches(token, process.env.FDP_WHATSAPP_VERIFY_TOKEN ?? "")) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "Verificação recusada." }, { status: 403 });
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
    const rawPayload = await request.text();
    if (new TextEncoder().encode(rawPayload).byteLength > 64 * 1024) {
      return Response.json({ error: "Payload do webhook excede 64 KB." }, { status: 413 });
    }

    const d1 = getD1();
    const workspace = await d1.prepare("SELECT id FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first<{ id: string }>();
    if (!workspace) return Response.json({ error: "Workspace não encontrado." }, { status: 404 });
    const integration = await d1.prepare("SELECT id, status, config_json FROM fdp_integrations WHERE workspace_id = ? AND channel = ?").bind(workspaceId, channel).first<{ id: string; status: string; config_json: string }>();
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
    const providerSignature = request.headers.get("x-hub-signature-256") ?? "";
    const genericAuthorized = secretMatches(receivedSecret, expectedSecret);
    const metaAuthorized = channel === "whatsapp" && whatsappSignatureMatches(rawPayload, providerSignature);
    if (!genericAuthorized && !metaAuthorized) return Response.json({ error: "Webhook não autorizado." }, { status: 401 });
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      payload = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Payload JSON inválido." }, { status: 400 });
    }

    if (metaAuthorized) {
      const config = JSON.parse(integration.config_json || "{}") as Record<string, unknown>;
      const expectedPhoneId = text(config.account, 120);
      const phoneIds = metaWhatsappPhoneIds(payload);
      if (!expectedPhoneId || !phoneIds.length || phoneIds.some((phoneId) => phoneId !== expectedPhoneId)) {
        return Response.json({ error: "Número do WhatsApp não corresponde ao workspace." }, { status: 403 });
      }
    }

    const metaMessages = metaAuthorized ? metaWhatsappMessages(payload) : [];
    const genericBody = messageText(payload.body ?? payload.text ?? payload.message, 5000);
    const messages = metaAuthorized ? metaMessages : genericBody ? [{
      senderName: text(payload.senderName ?? payload.from ?? payload.sender, 160) || "Solicitante externo",
      subject: text(payload.subject ?? payload.title ?? payload.event, 240) || `Solicitação via ${channel}`,
      body: genericBody,
      externalId: text(payload.externalId ?? payload.messageId ?? payload.id, 180),
    }] : [];
    if (!messages.length && !metaAuthorized) return Response.json({ error: "Mensagem vazia." }, { status: 400 });

    const inboxIds: string[] = [];
    let created = 0;
    let duplicates = 0;
    for (const message of messages.slice(0, 100)) {
      const inboxId = crypto.randomUUID();
      const taggedBody = message.externalId ? `${message.body}\n\n[external:${message.externalId}]` : message.body;
      const inserted = await d1.prepare(`INSERT INTO fdp_workspace_inbox_items
        (id, workspace_id, channel, sender_name, subject, body, external_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'new')
        ON CONFLICT (workspace_id, channel, external_id) DO NOTHING
        RETURNING id`)
        .bind(inboxId, workspaceId, channel, message.senderName, message.subject, taggedBody, message.externalId || null)
        .first<{ id: string }>();
      if (inserted) {
        created += 1;
        inboxIds.push(inserted.id);
        await recordActivity(workspaceId, null, `integration:${channel}`, "inbox.webhook_received", { channel, inboxId: inserted.id, externalId: message.externalId || null });
      } else if (message.externalId) {
        duplicates += 1;
        const duplicate = await d1.prepare("SELECT id FROM fdp_workspace_inbox_items WHERE workspace_id = ? AND channel = ? AND external_id = ? LIMIT 1")
          .bind(workspaceId, channel, message.externalId)
          .first<{ id: string }>();
        if (duplicate) inboxIds.push(duplicate.id);
      }
    }
    await d1.prepare("UPDATE fdp_integrations SET last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, status = 'connected', updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND channel = ?").bind(workspaceId, channel).run();
    return Response.json({
      accepted: true,
      ignored: metaAuthorized && messages.length === 0,
      duplicate: created === 0 && duplicates > 0,
      received: messages.length,
      created,
      duplicates,
      inboxId: inboxIds[0] ?? null,
      inboxIds,
    }, { status: created > 0 ? 202 : 200 });
  } catch (error) {
    return apiError(error);
  }
}
