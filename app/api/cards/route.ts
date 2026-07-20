import { apiError, computeSlaStatus, getApiUser, text, validDate } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole, runAutomations } from "@/lib/fila-dp-db";
import { addBusinessDays, replaceCardRelations } from "@/lib/fila-dp-relations";

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const title = text(body.title, 180);
    if (!title) return Response.json({ error: "Informe o título da demanda." }, { status: 400 });

    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    const assigneeName = text(body.assigneeName, 120);
    const hasAssignees = Array.isArray(body.assigneeIds) ? body.assigneeIds.length > 0 : Boolean(assigneeName);
    const requestedListId = text(body.listId, 80);
    let list = requestedListId
      ? await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ?").bind(requestedListId, board.id).first<{ id: string; kind: string; sla_behavior: string }>()
      : null;

    if (!list) {
      list = await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE board_id = ? AND kind = 'new'").bind(board.id).first<{ id: string; kind: string; sla_behavior: string }>();
    }
    if (!list) throw new Error("Coluna não encontrada.");

    const requestedTemplateId = text(body.templateId, 120);
    const template = requestedTemplateId
      ? await d1.prepare("SELECT * FROM fdp_process_templates WHERE id = ? AND workspace_id = ? AND active = 1").bind(requestedTemplateId, workspace.id).first<Record<string, unknown>>()
      : null;
    if (requestedTemplateId && !template) return Response.json({ error: "Template inválido." }, { status: 400 });
    const processType = template ? String(template.process_type) : (text(body.processType, 40).toUpperCase() || "OUTROS");
    let dueAt = validDate(body.dueAt);
    if (!dueAt) {
      const [settings, holidays, policy] = await Promise.all([
        d1.prepare("SELECT business_days_json FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspace.id).first<{ business_days_json: string }>(),
        d1.prepare("SELECT holiday_date FROM fdp_business_holidays WHERE workspace_id = ?").bind(workspace.id).all<{ holiday_date: string }>(),
        d1.prepare("SELECT target_business_days FROM fdp_sla_policies WHERE workspace_id = ? AND process_type = ? AND active = 1").bind(workspace.id, processType).first<{ target_business_days: number }>(),
      ]);
      const businessDays = settings ? (JSON.parse(settings.business_days_json) as number[]) : [1, 2, 3, 4, 5];
      const holidaySet = new Set(holidays.results.map((item) => item.holiday_date));
      const target = Number(template?.default_sla_days ?? policy?.target_business_days ?? 3);
      dueAt = addBusinessDays(new Date().toISOString().slice(0, 10), target, businessDays, holidaySet);
    }
    const priority = ["low", "normal", "high", "urgent"].includes(String(body.priority)) ? String(body.priority) : "normal";
    const positionRow = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0").bind(list.id).first<{ max_position: number }>();
    const cardId = crypto.randomUUID();
    const fallbackTemplate = template ?? await d1.prepare("SELECT * FROM fdp_process_templates WHERE workspace_id = ? AND process_type = ? AND active = 1 ORDER BY position LIMIT 1").bind(workspace.id, processType).first<Record<string, unknown>>();
    const checklist = fallbackTemplate ? JSON.parse(String(fallbackTemplate.checklist_json)) as string[] : ["Analisar solicitação", "Executar atividade", "Conferir conclusão"];

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_cards
        (id, board_id, list_id, title, description, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`)
        .bind(
          cardId,
          board.id,
          list.id,
          title,
          text(body.description),
          text(body.company, 160),
          processType,
          priority,
          assigneeName,
          dueAt,
          computeSlaStatus(dueAt, list.sla_behavior),
          Number(positionRow?.max_position ?? 0) + 1000,
          auth.user.email,
        ),
      ...checklist.map((item, index) => d1.prepare("INSERT INTO fdp_checklist_items (id, card_id, title, completed, position) VALUES (?, ?, ?, 0, ?)")
        .bind(crypto.randomUUID(), cardId, item, (index + 1) * 1000)),
    ]);

    await replaceCardRelations(d1, workspace.id, cardId, body);
    await runAutomations(workspace.id, board.id, cardId, "card.created", auth.user.email, { processType, priority });
    if (hasAssignees) await runAutomations(workspace.id, board.id, cardId, "assignee.added", auth.user.email, { assignee: "present" });

    await recordActivity(workspace.id, cardId, auth.user.email, "card.created", { title, listKind: list.kind, templateId: template?.id ?? null });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

