import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import { apiError, text } from "@/lib/fila-dp-api";

type RouteContext = { params: Promise<{ channel: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { channel: rawChannel } = await context.params;
    const channel = rawChannel.toLowerCase();
    if (!["email", "whatsapp", "teams"].includes(channel)) return Response.json({ error: "Canal não suportado." }, { status: 404 });
    const url = new URL(request.url);
    const workspaceId = text(url.searchParams.get("workspaceId"), 100);
    const runtimeEnv = env as unknown as Record<string, unknown>;
    const secretKey = `FDP_${channel.toUpperCase()}_WEBHOOK_SECRET`;
    const expectedSecret = String(runtimeEnv[secretKey] ?? "");
    const receivedSecret = request.headers.get("x-fila-dp-secret") ?? request.headers.get("x-webhook-secret") ?? "";
    if (!expectedSecret || receivedSecret !== expectedSecret) return Response.json({ error: "Webhook não autorizado." }, { status: 401 });
    if (!workspaceId) return Response.json({ error: "workspaceId obrigatório." }, { status: 400 });
    const payload = await request.json() as Record<string, unknown>;
    const senderName = text(payload.senderName ?? payload.from ?? payload.sender, 160) || "Solicitante externo";
    const subject = text(payload.subject ?? payload.title ?? payload.event, 240) || `Solicitação via ${channel}`;
    const body = text(payload.body ?? payload.text ?? payload.message, 5000);
    if (!body) return Response.json({ error: "Mensagem vazia." }, { status: 400 });
    const d1 = getD1();
    const workspace = await d1.prepare("SELECT id FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first<{ id: string }>();
    if (!workspace) return Response.json({ error: "Workspace não encontrado." }, { status: 404 });
    const integration = await d1.prepare("SELECT id FROM fdp_integrations WHERE workspace_id = ? AND channel = ?").bind(workspaceId, channel).first();
    if (!integration) return Response.json({ error: "Integração não configurada." }, { status: 409 });
    const externalId = text(payload.externalId ?? payload.messageId ?? payload.id, 180);
    if (externalId) {
      const duplicate = await d1.prepare("SELECT id FROM fdp_workspace_inbox_items WHERE workspace_id = ? AND body LIKE ? LIMIT 1").bind(workspaceId, `%[external:${externalId}]%`).first();
      if (duplicate) return Response.json({ accepted: true, duplicate: true, inboxId: duplicate.id });
    }
    const inboxId = crypto.randomUUID();
    const taggedBody = externalId ? `${body}\n\n[external:${externalId}]` : body;
    await d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status) VALUES (?, ?, ?, ?, ?, ?, 'new')").bind(inboxId, workspaceId, channel, senderName, subject, taggedBody).run();
    await d1.prepare("UPDATE fdp_integrations SET last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, status = 'connected', updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND channel = ?").bind(workspaceId, channel).run();
    return Response.json({ accepted: true, inboxId }, { status: 202 });
  } catch (error) { return apiError(error); }
}
