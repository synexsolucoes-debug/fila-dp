import { createHash } from "node:crypto";
import { getScopedD1 } from "@/db";
import { apiError, text } from "@/lib/fila-dp-api";
import { recordActivity } from "@/lib/fila-dp-db";
import { ApiError } from "@/lib/api-errors";
import { log, requestIdFrom } from "@/lib/observability";
import {
  completeIntegrationEvent, processIntegrationEvent, recordIntegrationEvent,
} from "@/lib/integration-events";
import {
  assertWebhookSecret, parseTeamsConfig, parseTeamsPayload, processTeamsMessage,
  resolveWebhookSecret, teamsEventId, type TeamsProcessingResult,
} from "@/lib/teams-integration";
import { setTenantContext } from "@/lib/tenant-context";

type RouteContext = { params: Promise<{ channel: string }> };

/**
 * Entrada de webhook de integração, por workspace.
 *
 * Três coisas mudaram em relação à versão anterior, e as três são a mesma
 * correção estrutural — a integração pertence ao workspace, não ao deployment:
 *
 * 1. o segredo de assinatura vem da credencial **do workspace**, cifrada no
 *    cofre, e não mais de uma variável de ambiente compartilhada por todos os
 *    clientes (`resolveWebhookSecret`);
 * 2. todo evento passa pela central de eventos antes de gerar qualquer coisa,
 *    então reentrega do provedor não vira demanda duplicada;
 * 3. mensagem do Teams é interpretada e vira demanda de movimentação, sugestão
 *    pendente de validação, ou nada — em vez de sempre virar item de caixa de
 *    entrada.
 *
 * O `workspaceId` chega pela URL, mas ele **não** é aceito por si só: a
 * requisição só passa se o segredo conferir com o daquele workspace. Um
 * identificador trocado na URL não abre a porta de outro cliente porque o
 * segredo não confere.
 */

function messageText(value: unknown, max = 5000): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const nested = record.content ?? record.text ?? record.plainText ?? record.value ?? record.body;
  if (typeof nested === "string") {
    return nested.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }
  return "";
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = requestIdFrom(request);
  try {
    const { channel: rawChannel } = await context.params;
    const channel = rawChannel.toLowerCase();
    if (!["email", "whatsapp", "teams"].includes(channel)) {
      return Response.json({ error: "Canal não suportado." }, { status: 404 });
    }

    const url = new URL(request.url);
    const workspaceId = text(url.searchParams.get("workspaceId"), 100);
    if (!workspaceId) return Response.json({ error: "workspaceId obrigatório." }, { status: 400 });

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024) {
      return Response.json({ error: "Payload do webhook excede 64 KB." }, { status: 413 });
    }

    setTenantContext({ workspaceId, userId: null });
    // A conexão carrega o tenant explicitamente: depender do AsyncLocalStorage
    // aqui deixaria as consultas sem `app.workspace_id`, e com RLS ativo isso
    // devolve zero linha em silêncio.
    const d1 = getScopedD1({ workspaceId, userId: null });

    const integration = await d1.prepare(
      "SELECT id, status, config_json FROM fdp_integrations WHERE workspace_id = ? AND channel = ?",
    ).bind(workspaceId, channel).first<{ id: string; status: string; config_json: string }>();
    // Resposta idêntica para workspace inexistente e integração não configurada:
    // distinguir os dois casos antes da autenticação diria a quem sondar quais
    // identificadores existem.
    if (!integration) {
      log("warn", "integration.webhook_unconfigured", { workspaceId, requestId }, { channel });
      return Response.json({ error: "Webhook não autorizado." }, { status: 401 });
    }

    const expectedSecret = await resolveWebhookSecret(d1, workspaceId, integration.id, channel);
    const receivedSecret = request.headers.get("x-fila-dp-secret") ?? request.headers.get("x-webhook-secret") ?? "";
    try {
      assertWebhookSecret(receivedSecret, expectedSecret);
    } catch (error) {
      log("warn", "integration.webhook_rejected", { workspaceId, connectorId: integration.id, requestId }, {
        channel, reason: error instanceof ApiError ? error.code : "UNKNOWN",
      });
      throw error;
    }

    if (integration.status === "paused") {
      return Response.json({ error: "Integração pausada.", code: "INTEGRATION_PAUSED" }, { status: 409 });
    }

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

    log("info", "integration.webhook_received", { workspaceId, connectorId: integration.id, requestId }, { channel });

    if (channel === "teams") {
      return await handleTeamsWebhook(d1, {
        workspaceId, requestId, integrationId: integration.id,
        configJson: integration.config_json, payload, rawPayload,
      });
    }

    return await handleInboxWebhook(d1, {
      workspaceId, requestId, integrationId: integration.id, channel, payload, rawPayload,
    });
  } catch (error) {
    return apiError(error);
  }
}

type Scoped = ReturnType<typeof getScopedD1>;

/**
 * Teams: interpreta a mensagem e cria a demanda no workspace **dono da
 * integração** — nunca em outro, porque o workspace vem do segredo conferido e
 * não de campo do payload.
 */
async function handleTeamsWebhook(d1: Scoped, input: {
  workspaceId: string; requestId: string; integrationId: string;
  configJson: string; payload: Record<string, unknown>; rawPayload: string;
}) {
  const config = parseTeamsConfig(parseJson(input.configJson));
  const teamsPayload = parseTeamsPayload(input.payload);
  const externalEventId = teamsEventId(teamsPayload, input.rawPayload);

  const recorded = await recordIntegrationEvent(d1, {
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    connector: "teams",
    eventType: "channel_message",
    externalEventId,
    source: "webhook",
    payloadHash: createHash("sha256").update(input.rawPayload).digest("hex"),
    payload: {
      teamId: teamsPayload.teamId, channelId: teamsPayload.channelId,
      messageId: teamsPayload.messageId, edited: Boolean(teamsPayload.editedAt),
    },
  });

  if (recorded.kind === "duplicate") {
    // Reentrega não é erro: responder 200 impede o provedor de tentar para
    // sempre, e nada novo é criado.
    return Response.json({
      accepted: true, duplicate: true, eventId: recorded.event.id, status: recorded.event.status,
      resultType: recorded.event.result_type || null, resultId: recorded.event.result_id || null,
    });
  }

  const processed = await processIntegrationEvent<TeamsProcessingResult>(d1, input.workspaceId, recorded.event, async () => {
    const result = await processTeamsMessage(d1, {
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      eventId: recorded.event.id,
      config,
      payload: teamsPayload,
    });
    if (result.outcome === "ignored") {
      return { outcome: { status: "ignored" as const, reason: result.reason }, value: result };
    }
    const resultId = result.outcome === "card" ? result.cardId : result.suggestionId;
    return {
      outcome: { status: "processed" as const, resultType: result.outcome, resultId },
      value: result,
    };
  });

  await touchIntegration(d1, input.workspaceId, "teams");
  const result = processed.value;
  if (!result) {
    return Response.json({ accepted: true, eventId: recorded.event.id, status: "processing" }, { status: 202 });
  }

  await recordActivity(input.workspaceId, result.outcome === "card" ? result.cardId : null, "integration:teams",
    result.outcome === "card" ? "teams.movement_demand_created"
      : result.outcome === "suggestion" ? "teams.movement_suggested" : "teams.message_ignored",
    {
      eventId: recorded.event.id,
      ...(result.outcome !== "ignored" ? { movementKind: result.kind, confidence: result.confidence } : { reason: result.reason }),
    });

  return Response.json({ accepted: true, eventId: recorded.event.id, ...result }, { status: 202 });
}

/** E-mail e WhatsApp continuam alimentando a caixa de entrada, agora com evento. */
async function handleInboxWebhook(d1: Scoped, input: {
  workspaceId: string; requestId: string; integrationId: string; channel: string;
  payload: Record<string, unknown>; rawPayload: string;
}) {
  const { payload } = input;
  const senderName = text(payload.senderName ?? payload.from ?? payload.sender, 160) || "Solicitante externo";
  const subject = text(payload.subject ?? payload.title ?? payload.event, 240) || `Solicitação via ${input.channel}`;
  const body = messageText(payload.body ?? payload.text ?? payload.message, 5000);
  if (!body) return Response.json({ error: "Mensagem vazia.", code: "WEBHOOK_EMPTY_MESSAGE" }, { status: 400 });

  const payloadHash = createHash("sha256").update(input.rawPayload).digest("hex");
  const externalId = text(payload.externalId ?? payload.messageId ?? payload.id, 180);
  const recorded = await recordIntegrationEvent(d1, {
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    connector: input.channel,
    eventType: "inbox_message",
    externalEventId: externalId ? `${input.channel}:${externalId}` : `${input.channel}:hash:${payloadHash}`,
    source: "webhook",
    payloadHash,
  });

  if (recorded.kind === "duplicate") {
    return Response.json({
      accepted: true, duplicate: true, eventId: recorded.event.id,
      inboxId: recorded.event.result_id || null,
    });
  }

  const inboxId = crypto.randomUUID();
  await d1.prepare(
    "INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status) VALUES (?, ?, ?, ?, ?, ?, 'new')",
  ).bind(inboxId, input.workspaceId, input.channel, senderName, subject, body).run();
  await completeIntegrationEvent(d1, input.workspaceId, recorded.event.id, {
    status: "processed", resultType: "inbox", resultId: inboxId,
  });

  await touchIntegration(d1, input.workspaceId, input.channel);
  await recordActivity(input.workspaceId, null, `integration:${input.channel}`, "inbox.webhook_received", {
    channel: input.channel, inboxId, eventId: recorded.event.id,
  });
  return Response.json({ accepted: true, inboxId, eventId: recorded.event.id }, { status: 202 });
}

function parseJson(value: unknown) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

async function touchIntegration(d1: Scoped, workspaceId: string, channel: string) {
  await d1.prepare(
    `UPDATE fdp_integrations
        SET last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, status = 'connected', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND channel = ?`,
  ).bind(workspaceId, channel).run();
}
