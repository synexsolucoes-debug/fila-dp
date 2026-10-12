import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { historyRecordFromRow, previousDay } from "@/lib/employee-history";
import { competenceOf, expectedEsocialEvents, lastDayOfCompetence } from "@/lib/erp-dp";
import type { WorkspaceRole } from "@/lib/fila-dp-types";

/**
 * ERP DP — conferência do eSocial (docs/engenharia-reversa-sap-hcm.md §16, item 7).
 *
 * Grava o que a pessoa confirmou no sistema de folha sobre cada evento que o
 * histórico funcional exige: **transmitido**, com o número do recibo, ou
 * **não se aplica**, com o motivo. O Vinculato não transmite (§28) — ele
 * guarda a prova da conferência.
 *
 * Aceita um evento ou um lote (`items`, até 500 — a importação de recibos).
 * Cada item é conferido contra o histórico: só se confere evento que o
 * histórico de fato exige, na data que ele informa.
 */

type CheckInput = { historyRecordId: string; eventCode: string; eventDate: string; status: "transmitted" | "not_applicable"; receipt: string; notes: string };

function parseItem(raw: Record<string, unknown>): CheckInput {
  const historyRecordId = cleanText(raw.historyRecordId, 120);
  const eventCode = cleanText(raw.eventCode, 10);
  const eventDate = optionalDate(raw.eventDate, true) as string;
  const status = raw.status === "not_applicable" ? "not_applicable" : "transmitted";
  const receipt = cleanText(raw.receipt, 80);
  const notes = cleanText(raw.notes, 500);
  if (!historyRecordId || !["S-2206", "S-2230", "S-2299"].includes(eventCode)) {
    throw ApiError.badRequest("Evento do eSocial inválido.", "ESOCIAL_EVENT_INVALID");
  }
  if (status === "transmitted" && !receipt) throw ApiError.badRequest("Informe o número do recibo do evento transmitido.", "ESOCIAL_RECEIPT_REQUIRED");
  if (status === "not_applicable" && !notes) throw ApiError.badRequest("Diga por que o evento não se aplica.", "ESOCIAL_REASON_REQUIRED");
  return { historyRecordId, eventCode, eventDate, status, receipt: status === "transmitted" ? receipt : "", notes };
}

/** O registro existe, está no escopo da pessoa e de fato exige este evento nesta data. */
async function assertExpected(d1: SqlDatabase, workspace: { id: string; role: WorkspaceRole }, userId: string, item: CheckInput) {
  const record = await d1.prepare(`SELECT h.employee_id, e.company_id FROM fdp_employee_history_records h
      JOIN fdp_employees e ON e.workspace_id = h.workspace_id AND e.id = h.employee_id
      WHERE h.workspace_id = ? AND h.id = ?`).bind(workspace.id, item.historyRecordId).first<{ employee_id: string; company_id: string }>();
  if (!record) throw ApiError.notFound("Registro do histórico não encontrado.", "ESOCIAL_RECORD_NOT_FOUND");
  await requireCompanyAccess(d1, workspace.id, userId, workspace.role, String(record.company_id));
  const competence = competenceOf(item.eventDate);
  const rows = await d1.prepare(`SELECT * FROM fdp_employee_history_records
      WHERE workspace_id = ? AND employee_id = ? AND valid_to >= ?::date AND valid_from <= (?::date + 1)`)
    .bind(workspace.id, record.employee_id, previousDay(`${competence}-01`), lastDayOfCompetence(competence)).all<Record<string, unknown>>();
  const expected = expectedEsocialEvents(rows.results.map((row) => ({ ...historyRecordFromRow(row), employeeId: String(record.employee_id) })), competence);
  if (!expected.some((event) => event.recordId === item.historyRecordId && event.event === item.eventCode && event.date === item.eventDate)) {
    throw ApiError.badRequest(`O histórico não exige ${item.eventCode} em ${item.eventDate} para este registro.`, "ESOCIAL_EVENT_NOT_EXPECTED");
  }
  return String(record.employee_id);
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "obligations.manage");
    const rawItems = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [body];
    if (!rawItems.length || rawItems.length > 500) throw ApiError.badRequest("Envie de 1 a 500 eventos por vez.", "ESOCIAL_BATCH_SIZE");
    const items = rawItems.map(parseItem);
    const statements: SqlPreparedStatement[] = [];
    for (const item of items) {
      const employeeId = await assertExpected(d1, workspace, user.id, item);
      statements.push(d1.prepare(`INSERT INTO fdp_esocial_event_checks
          (id, workspace_id, employee_id, history_record_id, event_code, event_date, status, receipt, notes, checked_by)
        VALUES (?, ?, ?, ?, ?, ?::date, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, history_record_id, event_code, event_date) DO UPDATE SET status = EXCLUDED.status,
          receipt = EXCLUDED.receipt, notes = EXCLUDED.notes, checked_by = EXCLUDED.checked_by, checked_at = now()`)
        .bind(crypto.randomUUID(), workspace.id, employeeId, item.historyRecordId, item.eventCode, item.eventDate,
          item.status, item.receipt, item.notes, user.id));
    }
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "esocial.events.checked", entityType: "esocial_check", entityId: crypto.randomUUID(),
      after: { items: items.map(({ historyRecordId, eventCode, eventDate, status, receipt }) => ({ historyRecordId, eventCode, eventDate, status, receipt })) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));
    await d1.batch(statements);
    return Response.json({ checked: items.length });
  } catch (error) { return apiError(error); }
}

/** Desfaz uma conferência marcada por engano; a trilha fica na auditoria. */
export async function DELETE(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const url = new URL(request.url);
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "obligations.manage");
    const historyRecordId = cleanText(url.searchParams.get("historyRecordId"), 120);
    const eventCode = cleanText(url.searchParams.get("eventCode"), 10);
    const eventDate = optionalDate(url.searchParams.get("eventDate"), true) as string;
    const current = await d1.prepare(`SELECT c.*, e.company_id FROM fdp_esocial_event_checks c
        JOIN fdp_employees e ON e.workspace_id = c.workspace_id AND e.id = c.employee_id
        WHERE c.workspace_id = ? AND c.history_record_id = ? AND c.event_code = ? AND c.event_date = ?::date`)
      .bind(workspace.id, historyRecordId, eventCode, eventDate).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Conferência não encontrada.", "ESOCIAL_CHECK_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    await d1.batch([
      d1.prepare("DELETE FROM fdp_esocial_event_checks WHERE workspace_id = ? AND id = ?").bind(workspace.id, current.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "esocial.event.unchecked", entityType: "esocial_check", entityId: String(current.id),
        before: { historyRecordId, eventCode, eventDate, status: current.status, receipt: current.receipt },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ deleted: true });
  } catch (error) { return apiError(error); }
}
