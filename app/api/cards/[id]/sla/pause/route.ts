import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCardCompanyAccess, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { businessMinutesBetween } from "@/lib/fila-dp-sla";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { reason?: string };
    const reason = text(body.reason, 240);
    if (!reason) return Response.json({ error: "Informe o motivo da pausa." }, { status: 400 });
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
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
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, id);
    const active = await d1.prepare("SELECT id, started_at, reason FROM fdp_card_sla_pauses WHERE card_id = ? AND workspace_id = ? AND ended_at IS NULL").bind(id, workspace.id).first<{ id: string; started_at: string; reason: string }>();
    if (!active) return Response.json({ error: "Esta demanda não está pausada." }, { status: 400 });
    const [settings, holidays] = await Promise.all([
      d1.prepare("SELECT business_days_json, day_start, day_end FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspace.id).first<{ business_days_json: string; day_start: string; day_end: string }>(),
      d1.prepare("SELECT holiday_date FROM fdp_business_holidays WHERE workspace_id = ?").bind(workspace.id).all<{ holiday_date: string }>(),
    ]);
    const businessDays = settings ? (JSON.parse(settings.business_days_json) as number[]) : [1, 2, 3, 4, 5];
    const minutes = businessMinutesBetween(active.started_at, new Date(), {
      businessDays,
      holidays: new Set(holidays.results.map((holiday) => holiday.holiday_date)),
      dayStart: settings?.day_start ?? "08:00",
      dayEnd: settings?.day_end ?? "18:00",
      timezone: workspace.timezone,
    });
    await d1.batch([
      d1.prepare("UPDATE fdp_card_sla_pauses SET ended_at = CURRENT_TIMESTAMP WHERE id = ?").bind(active.id),
      d1.prepare("UPDATE fdp_cards SET sla_status = 'safe', sla_pause_reason = '', sla_paused_minutes = sla_paused_minutes + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(minutes, id),
    ]);
    await recordActivity(workspace.id, id, auth.user.email, "sla.resumed", { minutes, reason: active.reason });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) { return apiError(error); }
}
