import { getD1 } from "@/db";
import { sendTransactionalEmail } from "@/lib/fila-dp-email";
import { runAutomations } from "@/lib/fila-dp-db";
import { evaluateSla, type SlaCalendar } from "@/lib/fila-dp-sla";

type WorkspaceRow = { id: string; name: string; timezone: string };
type CardRow = {
  id: string;
  board_id: string;
  title: string;
  company_id: string | null;
  process_type: string;
  due_at: string | null;
  sla_status: string;
  sla_target_minutes: number;
  sla_started_at: string | null;
  sla_paused_minutes: number;
  sla_escalation_level: number;
  sla_behavior: string;
  active_pause: number;
};

function safeBusinessDays(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      const days = parsed.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
      if (days.length) return days;
    }
  } catch { /* Use the standard work week. */ }
  return [1, 2, 3, 4, 5];
}

async function processWorkspace(workspace: WorkspaceRow, now: Date) {
  const d1 = getD1();
  const [settings, holidays, policies, cards] = await Promise.all([
    d1.prepare("SELECT business_days_json, day_start, day_end FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspace.id).first<{ business_days_json: string; day_start: string; day_end: string }>(),
    d1.prepare("SELECT holiday_date FROM fdp_business_holidays WHERE workspace_id = ?").bind(workspace.id).all<{ holiday_date: string }>(),
    d1.prepare("SELECT process_type, warning_business_days FROM fdp_sla_policies WHERE workspace_id = ? AND active = 1").bind(workspace.id).all<{ process_type: string; warning_business_days: number }>(),
    d1.prepare(`SELECT c.id, c.board_id, c.title, c.company_id, c.process_type, c.due_at, c.sla_status,
        c.sla_target_minutes, c.sla_started_at, c.sla_paused_minutes, c.sla_escalation_level,
        l.sla_behavior, CASE WHEN EXISTS (
          SELECT 1 FROM fdp_card_sla_pauses p WHERE p.card_id = c.id AND p.ended_at IS NULL
        ) THEN 1 ELSE 0 END AS active_pause
      FROM fdp_cards c
      JOIN fdp_boards b ON b.id = c.board_id
      JOIN fdp_lists l ON l.id = c.list_id
      WHERE b.workspace_id = ? AND c.archived = 0
      ORDER BY c.updated_at
      LIMIT 5000`).bind(workspace.id).all<CardRow>(),
  ]);
  const calendar: SlaCalendar = {
    businessDays: safeBusinessDays(settings?.business_days_json ?? "[1,2,3,4,5]"),
    holidays: new Set(holidays.results.map((holiday) => holiday.holiday_date)),
    dayStart: settings?.day_start ?? "08:00",
    dayEnd: settings?.day_end ?? "18:00",
    timezone: workspace.timezone || "America/Sao_Paulo",
  };
  const warnings = new Map(policies.results.map((policy) => [policy.process_type, Number(policy.warning_business_days ?? 1)]));
  let changed = 0;
  let notifications = 0;
  let emails = 0;

  for (const card of cards.results) {
    const evaluation = evaluateSla({
      behavior: card.sla_behavior,
      activePause: Boolean(card.active_pause),
      dueAt: card.due_at,
      targetMinutes: Number(card.sla_target_minutes ?? 0),
      startedAt: card.sla_started_at,
      pausedMinutes: Number(card.sla_paused_minutes ?? 0),
      warningBusinessDays: Number(warnings.get(card.process_type) ?? 1),
    }, calendar, now);
    const previousStatus = card.sla_status;
    const previousLevel = Number(card.sla_escalation_level ?? 0);
    const statusChanged = previousStatus !== evaluation.status;
    const escalationChanged = evaluation.escalationLevel > previousLevel;
    if (!statusChanged && !escalationChanged) continue;

    await d1.batch([
      d1.prepare("UPDATE fdp_cards SET sla_status = ?, sla_escalation_level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(evaluation.status, evaluation.escalationLevel, card.id),
      d1.prepare("INSERT INTO fdp_activity_events (id, workspace_id, card_id, actor_email, event_type, payload_json) VALUES (?, ?, ?, 'system:sla', 'sla.status_changed', ?)")
        .bind(crypto.randomUUID(), workspace.id, card.id, JSON.stringify({ from: previousStatus, to: evaluation.status, escalationLevel: evaluation.escalationLevel, overdueMinutes: evaluation.overdueMinutes })),
    ]);
    changed += 1;
    await runAutomations(workspace.id, card.board_id, card.id, "sla.tick", "system:sla", { status: evaluation.status, escalationLevel: evaluation.escalationLevel });

    if (evaluation.status !== "warning" && evaluation.status !== "overdue") continue;
    const recipients = await d1.prepare(`SELECT DISTINCT u.id, u.email, u.name
      FROM fdp_users u
      JOIN fdp_workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
      LEFT JOIN fdp_card_assignees ca ON ca.user_id = u.id AND ca.card_id = ?
      WHERE wm.role = 'admin' OR ca.user_id IS NOT NULL`).bind(workspace.id, card.id).all<{ id: string; email: string; name: string }>();
    const eventSuffix = evaluation.status === "overdue" ? `overdue:${evaluation.escalationLevel}` : "warning";
    const title = evaluation.status === "overdue" ? "SLA atrasado" : "SLA próximo do vencimento";
    const notificationBody = evaluation.status === "overdue"
      ? `${card.title} está atrasada e atingiu o nível ${evaluation.escalationLevel} de escalonamento.`
      : `${card.title} precisa de atenção antes do vencimento.`;

    for (const recipient of recipients.results) {
      const eventKey = `sla:${card.id}:${eventSuffix}:${recipient.id}`;
      const inserted = await d1.prepare(`INSERT INTO fdp_notifications
        (id, workspace_id, user_id, event_key, notification_type, title, body, card_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .bind(crypto.randomUUID(), workspace.id, recipient.id, eventKey, `sla.${evaluation.status}`, title, notificationBody, card.id)
        .run();
      if (!Number(inserted.meta.changes ?? 0)) continue;
      notifications += 1;
      const delivery = await sendTransactionalEmail({
        to: recipient.email,
        subject: `${title}: ${card.title}`,
        preheader: notificationBody,
        title: `Olá, ${recipient.name}.`,
        paragraphs: [notificationBody, `Grupo: ${workspace.name}. Processo: ${card.process_type}.`],
        actionLabel: "Abrir Fila DP",
        actionUrl: `${process.env.FDP_PUBLIC_URL || "https://fila-dp.vercel.app"}/painel`,
        idempotencyKey: eventKey,
      });
      if (delivery.status === "sent") emails += 1;
      if (delivery.status === "failed") console.error("[fila-dp][email] sla-alert", { workspaceId: workspace.id, cardId: card.id, recipient: recipient.email, error: delivery.error });
    }
  }

  return { workspaceId: workspace.id, cards: cards.results.length, changed, notifications, emails };
}

export async function runSlaSweep(now = new Date()) {
  const workspaces = await getD1().prepare("SELECT id, name, timezone FROM fdp_workspaces ORDER BY id").all<WorkspaceRow>();
  const results = [];
  for (const workspace of workspaces.results) results.push(await processWorkspace(workspace, now));
  return { processedAt: now.toISOString(), workspaces: results };
}

