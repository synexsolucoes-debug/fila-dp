import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { reason?: string };
    const reason = text(body.reason, 240);
    if (!reason) return Response.json({ error: "Informe o motivo da pausa." }, { status: 400 });
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const card = await d1.prepare("SELECT id FROM fdp_cards WHERE id = ? AND board_id IN (SELECT id FROM fdp_boards WHERE workspace_id = ?) AND archived = 0").bind(id, workspace.id).first();
    if (!card) return Response.json({ error: "Demanda não encontrada." }, { status: 404 });
    await d1.batch([
      d1.prepare("UPDATE fdp_card_sla_pauses SET ended_at = CURRENT_TIMESTAMP WHERE card_id = ? AND ended_at IS NULL").bind(id),
      d1.prepare("INSERT INTO fdp_card_sla_pauses (id, workspace_id, card_id, reason, created_by) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), workspace.id, id, reason, auth.user.email),
      d1.prepare("UPDATE fdp_cards SET sla_status = 'paused', sla_pause_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(reason, id),
    ]);
    await recordActivity(workspace.id, id, auth.user.email, "sla.paused", { reason });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) { return apiError(error); }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const active = await d1.prepare("SELECT id, started_at, reason FROM fdp_card_sla_pauses WHERE card_id = ? AND workspace_id = ? AND ended_at IS NULL").bind(id, workspace.id).first<{ id: string; started_at: string; reason: string }>();
    if (!active) return Response.json({ error: "Esta demanda não está pausada." }, { status: 400 });
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(active.started_at.replace(" ", "T") + "Z").getTime()) / 60000));
    await d1.batch([
      d1.prepare("UPDATE fdp_card_sla_pauses SET ended_at = CURRENT_TIMESTAMP WHERE id = ?").bind(active.id),
      d1.prepare("UPDATE fdp_cards SET sla_status = 'safe', sla_pause_reason = '', sla_paused_minutes = sla_paused_minutes + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(minutes, id),
    ]);
    await recordActivity(workspace.id, id, auth.user.email, "sla.resumed", { minutes, reason: active.reason });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) { return apiError(error); }
}
