import { ApiError, apiError, computeSlaStatus, getApiUser, text, validProcessType } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { responsavelPara } from "@/lib/portfolio-assignment";
import {
  TrelloImportError, planTrelloImport, readTrelloExport, suggestLabelCompanies, suggestMemberMatches,
  type SlaBehavior, type TrelloImportMapping, type TrelloImportPlan,
} from "@/lib/trello-import";

/**
 * Importa um quadro do Trello como um quadro novo do Vinculato.
 *
 * `mode: "preview"` lê o arquivo e devolve o que existe nele, as sugestões de
 * correspondência e — com as escolhas já feitas — o plano. `mode: "commit"`
 * grava o mesmo plano numa transação só: ou o quadro entra inteiro, ou nada
 * entra. Ver `lib/trello-import.ts`.
 */

const BEHAVIORS = new Set<SlaBehavior>(["running", "paused", "completed"]);

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [text(key, 40), text(item, 120)])
    .filter(([key, item]) => key && item));
}

function readMapping(value: unknown, fallbackName: string): TrelloImportMapping {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const listBehavior = Object.fromEntries(Object.entries(stringMap(body.listBehavior))
    .filter(([, behavior]) => BEHAVIORS.has(behavior as SlaBehavior))) as Record<string, SlaBehavior>;
  return {
    boardName: text(body.boardName, 80) || fallbackName,
    defaultCompanyId: text(body.defaultCompanyId, 120),
    labelCompany: stringMap(body.labelCompany),
    defaultProcessType: text(body.defaultProcessType, 40) || "OUTROS",
    labelProcessType: stringMap(body.labelProcessType),
    listBehavior,
    members: stringMap(body.members),
    includeArchived: body.includeArchived === true,
  };
}

function processTypeOrNull(value: string): string | null {
  try { return validProcessType(value); } catch { return null; }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as { mode?: string; board?: unknown; mapping?: unknown };
    const mode = body.mode === "commit" ? "commit" : "preview";
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    requireCapability(workspace, "workspace.manage");
    requireCapability(workspace, "cards.write");

    const board = readTrelloExport(body.board);
    const [companyRows, memberRows] = await Promise.all([
      d1.prepare("SELECT id, legal_name, trade_name FROM fdp_companies WHERE workspace_id = ? AND status = 'active' ORDER BY trade_name, legal_name")
        .bind(workspace.id).all<{ id: string; legal_name: string; trade_name: string }>(),
      /* Responsável é administrador ou membro, como na criação manual. */
      d1.prepare(`SELECT u.id AS user_id, u.name, wm.role,
            COALESCE((SELECT jsonb_agg(mca.company_id) FROM fdp_member_company_access mca
              WHERE mca.workspace_id = wm.workspace_id AND mca.user_id = u.id), '[]'::jsonb) AS company_ids
          FROM fdp_users u
          JOIN fdp_workspace_members wm ON wm.user_id = u.id
          WHERE wm.workspace_id = ? AND wm.role IN ('admin', 'member') ORDER BY u.name`)
        .bind(workspace.id).all<{ user_id: string; name: string; role: string; company_ids: string[] | string }>(),
    ]);
    const companies = companyRows.results.map((row) => ({ id: String(row.id), name: String(row.trade_name || row.legal_name) }));
    const members = memberRows.results.map((row) => ({ userId: String(row.user_id), name: String(row.name ?? "") }));
    const context = {
      companies,
      members: memberRows.results.map((row) => ({
        userId: String(row.user_id),
        name: String(row.name ?? ""),
        companyIds: row.role === "admin" ? null : new Set((typeof row.company_ids === "string" ? JSON.parse(row.company_ids) as string[] : row.company_ids).map(String)),
      })),
      isValidProcessType: processTypeOrNull,
    };

    if (mode === "preview") {
      const cardsPerList = new Map<string, number>();
      const cardsPerLabel = new Map<string, number>();
      for (const card of board.cards) {
        cardsPerList.set(card.idList, (cardsPerList.get(card.idList) ?? 0) + 1);
        card.idLabels.forEach((labelId) => cardsPerLabel.set(labelId, (cardsPerLabel.get(labelId) ?? 0) + 1));
      }
      const previous = await d1.prepare(`SELECT created_at FROM fdp_activity_events
          WHERE workspace_id = ? AND event_type = 'board.imported_trello' AND payload_json::jsonb ->> 'trelloBoardId' = ?
          ORDER BY created_at DESC LIMIT 1`)
        .bind(workspace.id, board.id).first<{ created_at: string }>();
      let plan: TrelloImportPlan | null = null;
      let planError = "";
      if (body.mapping) {
        try { plan = planTrelloImport(board, readMapping(body.mapping, board.name), context); }
        catch (error) { if (error instanceof TrelloImportError) planError = error.message; else throw error; }
      }
      return Response.json({
        board: {
          name: board.name,
          cards: board.cards.length,
          lists: [...board.lists].sort((a, b) => a.pos - b.pos).map((list) => ({ id: list.id, name: list.name, closed: list.closed, cards: cardsPerList.get(list.id) ?? 0 })),
          labels: board.labels.map((label) => ({ id: label.id, name: label.name, color: label.color, cards: cardsPerLabel.get(label.id) ?? 0 })),
          members: board.members.map((member) => ({ id: member.id, name: member.fullName || member.username })),
          comments: board.actions.length,
        },
        companies,
        members,
        suggestions: { members: suggestMemberMatches(board, members), labelCompany: suggestLabelCompanies(board, companies) },
        alreadyImportedAt: previous?.created_at ?? null,
        plan: plan ? { ...plan, cards: plan.cards.slice(0, 20) } : null,
        planError,
      });
    }

    const plan = planTrelloImport(board, readMapping(body.mapping, board.name), context);
    if (!plan.cards.length && !plan.lists.length) throw ApiError.badRequest("Não há nada para importar neste quadro.", "TRELLO_EMPTY");

    const taken = await d1.prepare("SELECT name FROM fdp_boards WHERE workspace_id = ?").bind(workspace.id).all<{ name: string }>();
    const names = new Set(taken.results.map((row) => String(row.name).toLowerCase()));
    let boardName = plan.boardName;
    for (let suffix = 2; names.has(boardName.toLowerCase()); suffix += 1) boardName = `${plan.boardName.slice(0, 70)} (${suffix})`;

    const existingLabels = await d1.prepare("SELECT id, name FROM fdp_labels WHERE workspace_id = ?").bind(workspace.id).all<{ id: string; name: string }>();
    const labelByName = new Map(existingLabels.results.map((row) => [String(row.name).toLowerCase(), String(row.id)]));
    const labelPosition = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM fdp_labels WHERE workspace_id = ?").bind(workspace.id).first<{ value: number }>();
    const newLabels: Array<{ id: string; name: string; color: string; position: number }> = [];
    const labelId = new Map<string, string>();
    for (const label of plan.labels) {
      const known = labelByName.get(label.name.toLowerCase());
      if (known) { labelId.set(label.trelloId, known); continue; }
      const id = crypto.randomUUID();
      labelByName.set(label.name.toLowerCase(), id);
      labelId.set(label.trelloId, id);
      newLabels.push({ id, name: label.name, color: label.color, position: Number(labelPosition?.value ?? 0) + (newLabels.length + 1) * 1000 });
    }

    const boardId = crypto.randomUUID();
    const lists = plan.lists.map((list) => ({ ...list, id: crypto.randomUUID() }));
    const memberName = new Map(members.map((member) => [member.userId, member.name]));
    const companyName = new Map(companies.map((company) => [company.id, company.name]));
    const cards = plan.cards.map((card) => ({ ...card, id: crypto.randomUUID() }));
    /* Carteira do DP: demanda aberta e sem responsável recebe quem responde
       pela empresa, como na criação manual. A carteira se resolve por empresa,
       então é uma consulta por empresa, não por demanda. Concluída e arquivada
       são histórico e ficam como vieram. */
    const orphanCompanies = [...new Set(cards
      .filter((card) => !card.archived && lists[card.listIndex].slaBehavior !== "completed" && !card.assigneeUserIds.length)
      .map((card) => card.companyId))];
    const portfolio = new Map<string, string>();
    for (const companyId of orphanCompanies) {
      const resolution = await responsavelPara(d1, workspace.id, companyId);
      if (resolution.userId) portfolio.set(companyId, resolution.userId);
    }
    let portfolioAssigned = 0;
    for (const card of cards) {
      const holder = portfolio.get(card.companyId);
      if (!holder || card.archived || lists[card.listIndex].slaBehavior === "completed" || card.assigneeUserIds.length) continue;
      card.assigneeUserIds = [holder];
      portfolioAssigned += 1;
    }
    const holderNames = portfolio.size
      ? await d1.prepare("SELECT id, name FROM fdp_users WHERE id IN (SELECT jsonb_array_elements_text(?::jsonb))")
        .bind(JSON.stringify([...new Set(portfolio.values())])).all<{ id: string; name: string }>()
      : { results: [] as Array<{ id: string; name: string }> };
    holderNames.results.forEach((row) => memberName.set(String(row.id), String(row.name ?? "")));
    const cardRows = cards.map((card) => {
      const list = lists[card.listIndex];
      return {
        id: card.id, list_id: list.id, title: card.title, description: card.description,
        company_id: card.companyId, company: companyName.get(card.companyId) ?? "",
        process_type: card.processType, assignee_name: memberName.get(card.assigneeUserIds[0] ?? "") ?? "",
        due_at: card.dueAt, sla_status: computeSlaStatus(card.dueAt, list.slaBehavior),
        position: card.position, archived: card.archived ? 1 : 0,
        created_at: card.createdAt, closed_at: card.closedAt,
      };
    });
    const assigneeRows = cards.flatMap((card) => card.assigneeUserIds.map((userId) => ({ card_id: card.id, user_id: userId })));
    const labelRows = cards.flatMap((card) => [...new Set(card.labelTrelloIds.map((trelloId) => labelId.get(trelloId)).filter(Boolean))]
      .map((id) => ({ card_id: card.id, label_id: id })));
    const checklistRows = cards.flatMap((card) => card.checklist.map((item) => ({
      id: crypto.randomUUID(), card_id: card.id, title: item.title, completed: item.completed ? 1 : 0, position: item.position,
    })));
    const commentRows = cards.flatMap((card) => card.comments.map((comment) => ({
      id: crypto.randomUUID(), card_id: card.id, body: comment.body, created_at: comment.createdAt,
    })));

    await d1.batch([
      d1.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, ?, ?, 'general')")
        .bind(boardId, workspace.id, boardName, text(`Importado do Trello: ${board.name}`, 300)),
      d1.prepare(`INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior)
          SELECT x.id, ?, ?, x.name, x.kind, x.position, x.sla_behavior
          FROM jsonb_to_recordset(?::jsonb) AS x(id text, name text, kind text, position double precision, sla_behavior text)`)
        .bind(workspace.id, boardId, JSON.stringify(lists.map((list) => ({ id: list.id, name: list.name, kind: list.kind, position: list.position, sla_behavior: list.slaBehavior })))),
      d1.prepare(`INSERT INTO fdp_labels (id, workspace_id, name, color, position)
          SELECT x.id, ?, x.name, x.color, x.position
          FROM jsonb_to_recordset(?::jsonb) AS x(id text, name text, color text, position double precision)`)
        .bind(workspace.id, JSON.stringify(newLabels)),
      d1.prepare(`INSERT INTO fdp_cards
          (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority,
           assignee_name, due_at, sla_status, position, source_type, archived, created_by, sla_started_at, created_at, closed_at)
          SELECT x.id, ?, ?, x.list_id, x.title, x.description, x.company_id, x.company, x.process_type, 'normal',
            x.assignee_name, x.due_at, x.sla_status, x.position, 'trello', x.archived, ?, CURRENT_TIMESTAMP,
            COALESCE(x.created_at, CURRENT_TIMESTAMP), x.closed_at
          FROM jsonb_to_recordset(?::jsonb) AS x(id text, list_id text, title text, description text, company_id text,
            company text, process_type text, assignee_name text, due_at timestamptz, sla_status text,
            position double precision, archived integer, created_at timestamptz, closed_at timestamptz)`)
        .bind(workspace.id, boardId, auth.user.email, JSON.stringify(cardRows)),
      d1.prepare(`INSERT INTO fdp_card_assignees (workspace_id, card_id, user_id)
          SELECT ?, x.card_id, x.user_id FROM jsonb_to_recordset(?::jsonb) AS x(card_id text, user_id text)`)
        .bind(workspace.id, JSON.stringify(assigneeRows)),
      d1.prepare(`INSERT INTO fdp_card_labels (workspace_id, card_id, label_id)
          SELECT ?, x.card_id, x.label_id FROM jsonb_to_recordset(?::jsonb) AS x(card_id text, label_id text)`)
        .bind(workspace.id, JSON.stringify(labelRows)),
      d1.prepare(`INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position, completed_at)
          SELECT x.id, ?, x.card_id, x.title, x.completed, x.position, CASE WHEN x.completed = 1 THEN CURRENT_TIMESTAMP END
          FROM jsonb_to_recordset(?::jsonb) AS x(id text, card_id text, title text, completed integer, position double precision)`)
        .bind(workspace.id, JSON.stringify(checklistRows)),
      d1.prepare(`INSERT INTO fdp_card_comments (id, workspace_id, card_id, author_user_id, body, created_at, updated_at)
          SELECT x.id, ?, x.card_id, ?, x.body, x.created_at, x.created_at
          FROM jsonb_to_recordset(?::jsonb) AS x(id text, card_id text, body text, created_at timestamptz)`)
        .bind(workspace.id, user.id, JSON.stringify(commentRows)),
      d1.prepare("UPDATE fdp_user_workspace_preferences SET active_board_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?")
        .bind(boardId, user.id, workspace.id),
    ]);

    await recordActivity(workspace.id, null, auth.user.email, "board.imported_trello", {
      boardId, name: boardName, trelloBoardId: board.id, ...plan.summary,
      unmappedMembers: plan.summary.unmappedMembers.length, portfolioAssigned,
    });
    return Response.json({ ...await getWorkspaceSnapshot(auth.user), imported: { boardId, boardName, ...plan.summary, portfolioAssigned, warnings: plan.warnings } }, { status: 201 });
  } catch (error) {
    if (error instanceof TrelloImportError) return apiError(ApiError.badRequest(error.message, error.code));
    return apiError(error);
  }
}
