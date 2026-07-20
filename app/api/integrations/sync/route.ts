import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

const supported = new Set(["email", "whatsapp", "teams", "drive", "onedrive", "erp"]);

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as { channel?: string };
    const channel = String(body.channel ?? "").toLowerCase();
    if (!supported.has(channel)) return Response.json({ error: "Canal não suportado." }, { status: 400 });
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const integration = await d1.prepare("SELECT id, config_json FROM fdp_integrations WHERE workspace_id = ? AND channel = ?").bind(workspace.id, channel).first<{ id: string; config_json: string }>();
    if (!integration) return Response.json({ error: "Configure a integração antes de sincronizar." }, { status: 409 });
    const config = JSON.parse(integration.config_json || "{}") as Record<string, unknown>;
    const endpoint = text(config.endpoint, 500);
    const runtimeEnv = env as unknown as Record<string, unknown>;
    const token = String(runtimeEnv[`FDP_${channel.toUpperCase()}_TOKEN`] ?? "");
    if (!endpoint || !token) return Response.json({ error: "Endpoint e credencial segura ainda não configurados." }, { status: 409 });
    const response = await fetch(endpoint, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`O provedor respondeu com status ${response.status}.`);
    const payload = await response.json() as { items?: Array<Record<string, unknown>> };
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
    if (items.length) await d1.batch(items.map((item) => d1.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status) VALUES (?, ?, ?, ?, ?, ?, 'new')").bind(crypto.randomUUID(), workspace.id, channel, text(item.senderName ?? item.from, 160) || "Integração", text(item.subject ?? item.title, 240) || `Atualização via ${channel}`, text(item.body ?? item.text, 5000))));
    await d1.prepare("UPDATE fdp_integrations SET status = 'connected', last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(integration.id).run();
    await recordActivity(workspace.id, null, auth.user.email, "integration.synced", { channel, count: items.length });
    return Response.json({ synced: items.length, snapshot: await getWorkspaceSnapshot(auth.user) });
  } catch (error) {
    return apiError(error);
  }
}
