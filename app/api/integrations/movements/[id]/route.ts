import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, recordActivity } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { log } from "@/lib/observability";
import { loadDemandTarget, parseTeamsConfig } from "@/lib/teams-integration";
import {
  applyCorrections, assertComplete, confirmedTaskDraft, presentSuggestion, type SuggestionRow,
} from "@/lib/movement-suggestions";

type Params = { params: Promise<{ id: string }> };

const columns = `id, workspace_id, integration_id, movement_kind, status, confidence, employee_name, employee_id,
  previous_salary_cents, new_salary_cents, previous_role, new_role, effective_date, requested_by_name,
  team_name, channel_name, message_id, message_url, original_message, missing_fields_json, signals_json,
  card_id, created_at`;

/**
 * Confirma ou rejeita uma movimentação sugerida.
 *
 * `confirm` transforma a sugestão em demanda, aplicando as correções de quem
 * revisou. `reject` encerra a sugestão sem criar nada, e o motivo fica gravado —
 * é o que permite descobrir depois que a interpretação erra sempre no mesmo
 * padrão de mensagem.
 *
 * A sugestão é buscada com `workspace_id` na cláusula: um identificador de outro
 * grupo simplesmente não é encontrado, e a resposta é 404 em vez de 403 — dizer
 * "existe, mas não é seu" já entrega informação.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const action = text(body.action, 20).toLowerCase();
    if (action !== "confirm" && action !== "reject") {
      throw ApiError.badRequest("Ação inválida. Use confirm ou reject.", "MOVEMENT_ACTION_INVALID");
    }

    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "cards.write");

    const row = await d1.prepare(`SELECT ${columns} FROM fdp_movement_suggestions WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<SuggestionRow>();
    if (!row) throw ApiError.notFound("Movimentação sugerida não encontrada.", "MOVEMENT_SUGGESTION_NOT_FOUND");
    if (row.status !== "pending") {
      throw new ApiError(409, "MOVEMENT_SUGGESTION_RESOLVED",
        `Esta sugestão já foi ${row.status === "confirmed" ? "confirmada" : row.status === "rejected" ? "rejeitada" : "substituída"}.`);
    }

    const note = text(body.note ?? body.reason, 500);

    if (action === "reject") {
      await d1.prepare(
        `UPDATE fdp_movement_suggestions
            SET status = 'rejected', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
                resolution_note = ?, updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = ? AND id = ?`,
      ).bind(user.id, note, workspace.id, id).run();

      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "integration.movement_rejected", entityType: "movement_suggestion", entityId: id,
        before: { status: "pending" }, after: { status: "rejected" },
        metadata: { kind: row.movement_kind, confidence: row.confidence, note },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      log("info", "integration.movement_rejected", { workspaceId: workspace.id, userId: user.id }, {
        suggestionId: id, movementKind: row.movement_kind, confidence: row.confidence,
      });
      return Response.json({ suggestion: { id, status: "rejected" } });
    }

    const corrections = applyCorrections(row, body);
    assertComplete(row.movement_kind, corrections);

    const integration = await d1.prepare("SELECT config_json FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, row.integration_id).first<{ config_json: string }>();
    const config = parseTeamsConfig(parseJson(integration?.config_json));
    const target = await loadDemandTarget(d1, workspace.id, config);
    const draft = confirmedTaskDraft(row, corrections, auth.user.email);
    const cardId = crypto.randomUUID();

    await d1.prepare(
      `INSERT INTO fdp_cards
         (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority,
          position, source_type, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal',
          COALESCE((SELECT MAX(position) FROM fdp_cards WHERE list_id = ? AND archived = 0), 0) + 1000,
          'integration', ?)`,
    ).bind(
      cardId, workspace.id, target.boardId, target.listId, draft.title, draft.description,
      target.companyId, target.companyName, draft.processType, target.listId, auth.user.email,
    ).run();

    await d1.batch(draft.checklist.map((item, index) => d1.prepare(
      "INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position) VALUES (?, ?, ?, ?, 0, ?)",
    ).bind(crypto.randomUUID(), workspace.id, cardId, item, (index + 1) * 1000)));

    await d1.prepare(
      `UPDATE fdp_movement_suggestions
          SET status = 'confirmed', card_id = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
              resolution_note = ?, employee_name = ?, employee_id = ?,
              previous_salary_cents = ?, new_salary_cents = ?, previous_role = ?, new_role = ?,
              effective_date = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ?`,
    ).bind(
      cardId, user.id, note, corrections.employeeName, corrections.employeeId,
      corrections.previousSalary === null ? null : Math.round(corrections.previousSalary * 100),
      corrections.newSalary === null ? null : Math.round(corrections.newSalary * 100),
      corrections.previousRole, corrections.newRole, corrections.effectiveDate,
      workspace.id, id,
    ).run();

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "integration.movement_confirmed", entityType: "movement_suggestion", entityId: id,
      before: { status: "pending" }, after: { status: "confirmed", cardId },
      metadata: { kind: row.movement_kind, confidence: row.confidence, processType: draft.processType },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();
    await recordActivity(workspace.id, cardId, auth.user.email, "teams.movement_confirmed", {
      suggestionId: id, movementKind: row.movement_kind,
    });
    log("info", "integration.demand_created", { workspaceId: workspace.id, userId: user.id }, {
      source: "teams_suggestion", suggestionId: id, cardId, movementKind: row.movement_kind,
    });

    const updated = await d1.prepare(`SELECT ${columns} FROM fdp_movement_suggestions WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<SuggestionRow>();
    return Response.json({ suggestion: updated ? presentSuggestion(updated) : { id, status: "confirmed" }, cardId }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

function parseJson(value: unknown) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}
