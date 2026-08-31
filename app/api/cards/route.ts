import { ApiError, apiError, computeSlaStatus, getApiUser, text, validDueAt, validProcessType } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireCompanyAccess, requireWorkspaceRole, runAutomations } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { addBusinessDays, replaceCardRelations } from "@/lib/fila-dp-relations";
import { workingDayMinutes } from "@/lib/fila-dp-sla";
import { validCompetence } from "@/lib/operations";
import { validateActiveAreaIds } from "@/lib/areas";

/** Página leve de demandas para telas que não podem carregar o snapshot inteiro. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "cards.read");
    const url = new URL(request.url);
    const cursor = text(url.searchParams.get("cursor"), 120);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
    const query = text(url.searchParams.get("q"), 120);
    const status = text(url.searchParams.get("status"), 30);
    const processVersionId = text(url.searchParams.get("processVersionId"), 120);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ cards: [], nextCursor: null });
    const where = ["card.workspace_id = ?", "card.board_id = ?"];
    const values: unknown[] = [workspace.id, board.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`card.company_id IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }
    if (cursor) { where.push("card.id > ?"); values.push(cursor); }
    if (query) { where.push("(card.title ILIKE ? OR card.company ILIKE ? OR card.process_type ILIKE ?)"); values.push(`%${query}%`, `%${query}%`, `%${query}%`); }
    if (status === "active") where.push("card.archived = 0");
    if (status === "archived") where.push("card.archived = 1");
    if (processVersionId) { where.push("card.process_version_id = ?"); values.push(processVersionId); }
    const result = await d1.prepare(`SELECT card.id, card.reference_number, card.title, card.description,
        card.company_id, card.company, card.employee_id, card.requester_user_id,
        card.requester_area_id, card.responsible_area_id, card.process_type, card.priority,
        card.assignee_name, card.due_at, card.sla_status, card.archived, card.list_id,
        card.process_definition_id, card.process_version_id, card.process_version_number,
        card.current_step_id, card.competence, card.created_at, card.updated_at,
        (SELECT COUNT(*)::int FROM fdp_demand_tasks task WHERE task.workspace_id = card.workspace_id AND task.card_id = card.id) AS tasks_total,
        (SELECT COUNT(*)::int FROM fdp_demand_tasks task WHERE task.workspace_id = card.workspace_id AND task.card_id = card.id AND task.status = 'completed') AS tasks_done
      FROM fdp_cards card WHERE ${where.join(" AND ")} ORDER BY card.id LIMIT ?`)
      .bind(...values, limit + 1).all<Record<string, unknown>>();
    const cards = result.results.slice(0, limit);
    return Response.json({ cards, nextCursor: result.results.length > limit ? String(cards.at(-1)?.id ?? "") : null });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const title = text(body.title, 180);
    if (!title) return Response.json({ error: "Informe o título da demanda." }, { status: 400 });

    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "cards.write");
    const requestedBoardId = text(body.boardId, 100);
    let targetBoard = board;
    if (requestedBoardId && requestedBoardId !== board.id) {
      const requestedBoard = await d1.prepare("SELECT id, name, description, board_type FROM fdp_boards WHERE id = ? AND workspace_id = ?")
        .bind(requestedBoardId, workspace.id)
        .first<{ id: string; name: string; description: string; board_type: string }>();
      if (!requestedBoard) return Response.json({ error: "Processo selecionado não encontrado." }, { status: 400 });
      targetBoard = requestedBoard;
    }
    const companyId = text(body.companyId, 120) || null;
    let companyName = text(body.company, 160);
    if (companyId) {
      const company = await d1.prepare("SELECT legal_name, trade_name FROM fdp_companies WHERE id = ? AND workspace_id = ? AND status = 'active'").bind(companyId, workspace.id).first<{ legal_name: string; trade_name: string }>();
      if (!company) return Response.json({ error: "Empresa selecionada não encontrada." }, { status: 400 });
      companyName = company.trade_name || company.legal_name;
    }
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const assigneeName = text(body.assigneeName, 120);
    const hasAssignees = Array.isArray(body.assigneeIds) ? body.assigneeIds.length > 0 : Boolean(assigneeName);
    const requestedListId = text(body.listId, 80);
    let list = requestedListId
      ? await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ?").bind(requestedListId, targetBoard.id).first<{ id: string; kind: string; sla_behavior: string }>()
      : null;

    if (!list) {
      // A coluna de entrada, e — se ela não existir — a primeira do quadro.
      //
      // Só `kind = 'new'` não bastava. O quadro nasce com essa coluna, mas o
      // administrador pode apagá-la: a exclusão de coluna só exige que sobre
      // uma. Reproduzido contra o produto de pé — apagada a coluna "Novas
      // demandas", o botão "Nova demanda" da barra superior passava a devolver
      // 404 "Coluna não encontrada". O quadro continuava com duas colunas e
      // aparência normal, e a ação central do produto estava quebrada com uma
      // mensagem sobre algo que a pessoa não pediu.
      //
      // Qualquer quadro com ao menos uma coluna recebe demanda.
      list = await d1.prepare(`SELECT id, kind, sla_behavior FROM fdp_lists
        WHERE board_id = ?
        ORDER BY (kind = 'new') DESC, position, id
        LIMIT 1`).bind(targetBoard.id).first<{ id: string; kind: string; sla_behavior: string }>();
    }
    if (!list) throw ApiError.notFound("Este quadro não tem nenhuma coluna. Crie uma coluna antes de abrir demandas.", "LIST_NOT_FOUND");

    const requestedTemplateId = text(body.templateId, 120);
    const template = requestedTemplateId
      ? await d1.prepare("SELECT * FROM fdp_process_templates WHERE id = ? AND workspace_id = ? AND active = 1").bind(requestedTemplateId, workspace.id).first<Record<string, unknown>>()
      : null;
    if (requestedTemplateId && !template) return Response.json({ error: "Template inválido." }, { status: 400 });
    const processType = validProcessType(template ? template.process_type : body.processType);
    let dueAt = validDueAt(body.dueAt);
    let slaTargetMinutes = 0;
    if (!dueAt) {
      const [settings, holidays, policy] = await Promise.all([
        d1.prepare("SELECT business_days_json, day_start, day_end FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspace.id).first<{ business_days_json: string; day_start: string; day_end: string }>(),
        d1.prepare("SELECT holiday_date FROM fdp_business_holidays WHERE workspace_id = ?").bind(workspace.id).all<{ holiday_date: string }>(),
        d1.prepare("SELECT target_business_days FROM fdp_sla_policies WHERE workspace_id = ? AND process_type = ? AND active = 1").bind(workspace.id, processType).first<{ target_business_days: number }>(),
      ]);
      const businessDays = settings ? (JSON.parse(settings.business_days_json) as number[]) : [1, 2, 3, 4, 5];
      const holidaySet = new Set(holidays.results.map((item) => item.holiday_date));
      const target = Number(template?.default_sla_days ?? policy?.target_business_days ?? 3);
      const dayEnd = settings?.day_end ?? "18:00";
      dueAt = `${addBusinessDays(new Date().toISOString().slice(0, 10), target, businessDays, holidaySet)}T${dayEnd}`;
      slaTargetMinutes = target * workingDayMinutes({ dayStart: settings?.day_start ?? "08:00", dayEnd });
    }
    const priority = ["low", "normal", "high", "urgent"].includes(String(body.priority)) ? String(body.priority) : "normal";
    const positionRow = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0").bind(list.id).first<{ max_position: number }>();
    const cardId = crypto.randomUUID();
    const fallbackTemplate = template ?? await d1.prepare("SELECT * FROM fdp_process_templates WHERE workspace_id = ? AND process_type = ? AND active = 1 ORDER BY position LIMIT 1").bind(workspace.id, processType).first<Record<string, unknown>>();
    const checklist = fallbackTemplate ? JSON.parse(String(fallbackTemplate.checklist_json)) as string[] : ["Analisar solicitação", "Executar atividade", "Conferir conclusão"];
    const competence = body.competence ? validCompetence(body.competence) : "";
    const legalDueAt = body.legalDueAt === undefined ? null : validDueAt(body.legalDueAt);
    const requesterAreaId = text(body.requesterAreaId, 120) || null;
    const responsibleAreaId = text(body.responsibleAreaId, 120) || null;
    await validateActiveAreaIds(d1, workspace.id, [requesterAreaId, responsibleAreaId]);

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_cards
        (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority, assignee_name, due_at, sla_status, position, source_type, created_by, sla_target_minutes, sla_started_at, competence, legal_due_at, process_template_id, requester_area_id, responsible_area_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)`)
        .bind(
          cardId,
          workspace.id,
          targetBoard.id,
          list.id,
          title,
          text(body.description),
          companyId,
          companyName,
          processType,
          priority,
          assigneeName,
          dueAt,
          computeSlaStatus(dueAt, list.sla_behavior),
          Number(positionRow?.max_position ?? 0) + 1000,
          auth.user.email,
          slaTargetMinutes,
          competence,
          legalDueAt,
          template?.id ?? null,
          requesterAreaId,
          responsibleAreaId,
        ),
      ...checklist.map((item, index) => d1.prepare("INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position) VALUES (?, ?, ?, ?, 0, ?)")
        .bind(crypto.randomUUID(), workspace.id, cardId, item, (index + 1) * 1000)),
      d1.prepare("UPDATE fdp_user_workspace_preferences SET active_board_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?")
        .bind(targetBoard.id, user.id, workspace.id),
    ]);

    await replaceCardRelations(d1, workspace.id, cardId, body);
    await runAutomations(workspace.id, targetBoard.id, cardId, "card.created", auth.user.email, { processType, priority });
    if (hasAssignees) await runAutomations(workspace.id, targetBoard.id, cardId, "assignee.added", auth.user.email, { assignee: "present" });

    await recordActivity(workspace.id, cardId, auth.user.email, "card.created", { title, boardId: targetBoard.id, listKind: list.kind, templateId: template?.id ?? null, competence, legalDueAt, requesterAreaId, responsibleAreaId });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

