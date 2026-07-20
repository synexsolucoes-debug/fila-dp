import { apiError, computeSlaStatus, getApiUser, text, validDate } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity } from "@/lib/fila-dp-db";

const checklistTemplates: Record<string, string[]> = {
  "ADMISSÃO": ["Documentos pessoais recebidos", "Exame admissional anexado", "Cadastro no sistema concluído"],
  "RESCISÃO": ["Aviso ou desligamento registrado", "Cálculo rescisório conferido", "Documentos finais enviados"],
  "FÉRIAS": ["Período aquisitivo validado", "Gestor confirmou as datas", "Aviso de férias emitido"],
  "BENEFÍCIOS": ["Elegibilidade validada", "Documentos conferidos", "Solicitação enviada à operadora"],
};

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const title = text(body.title, 180);
    if (!title) return Response.json({ error: "Informe o título da demanda." }, { status: 400 });

    const { d1, workspace, board } = await getWorkspaceContext(auth.user);
    const assigneeName = text(body.assigneeName, 120);
    const requestedListId = text(body.listId, 80);
    let list = requestedListId
      ? await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE id = ? AND board_id = ?").bind(requestedListId, board.id).first<{ id: string; kind: string; sla_behavior: string }>()
      : null;

    if (!list) {
      const kind = assigneeName ? "analysis" : "new";
      list = await d1.prepare("SELECT id, kind, sla_behavior FROM fdp_lists WHERE board_id = ? AND kind = ?").bind(board.id, kind).first<{ id: string; kind: string; sla_behavior: string }>();
    }
    if (!list) throw new Error("Coluna não encontrada.");

    const dueAt = validDate(body.dueAt);
    const processType = text(body.processType, 40).toUpperCase() || "OUTROS";
    const priority = ["low", "normal", "high", "urgent"].includes(String(body.priority)) ? String(body.priority) : "normal";
    const positionRow = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS max_position FROM fdp_cards WHERE list_id = ? AND archived = 0").bind(list.id).first<{ max_position: number }>();
    const cardId = crypto.randomUUID();
    const checklist = checklistTemplates[processType] ?? ["Analisar solicitação", "Executar atividade", "Conferir conclusão"];

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

    await recordActivity(workspace.id, cardId, auth.user.email, "card.created", { title, listKind: list.kind });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

