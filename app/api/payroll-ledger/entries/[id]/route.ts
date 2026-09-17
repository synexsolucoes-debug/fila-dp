import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { ledgerEntryFromRow, ledgerInstallmentFromRow, parseCategoryDetails } from "@/lib/payroll-ledger-service";
import type { LedgerCategory } from "@/lib/payroll-ledger";

/** O lançamento, suas parcelas, confirmações, documentos e histórico. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.read", "abrir um lançamento");

    const entry = await d1.prepare(`SELECT entry.*,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name,
        employee.full_name AS employee_name, employee.registration_number,
        employee.employment_status, employee.termination_date,
        provider.legal_name AS provider_name,
        department.name AS department_name,
        area.name AS requester_area_name,
        COALESCE(balance.planned_total, 0) AS planned_total,
        COALESCE(balance.discounted_total, 0) AS discounted_total,
        COALESCE(balance.open_installments, 0) AS open_installments
      FROM fdp_ledger_entries entry
      JOIN fdp_companies company
        ON company.workspace_id = entry.workspace_id AND company.id = entry.company_id
      LEFT JOIN fdp_employees employee
        ON employee.workspace_id = entry.workspace_id AND employee.id = entry.employee_id
      LEFT JOIN fdp_auxiliary_providers provider
        ON provider.workspace_id = entry.workspace_id AND provider.id = entry.provider_id
      LEFT JOIN fdp_departments department
        ON department.workspace_id = entry.workspace_id AND department.id = entry.department_id
      LEFT JOIN fdp_areas area
        ON area.workspace_id = entry.workspace_id AND area.id = entry.requester_area_id
      LEFT JOIN LATERAL (
        SELECT
          SUM(CASE WHEN installment.status IN ('canceled', 'rescheduled', 'skipped')
            THEN installment.discounted_amount ELSE installment.planned_amount END) AS planned_total,
          SUM(installment.discounted_amount) AS discounted_total,
          COUNT(*) FILTER (WHERE installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
            AND installment.discounted_amount < installment.planned_amount) AS open_installments
        FROM fdp_ledger_installments installment
        WHERE installment.workspace_id = entry.workspace_id AND installment.entry_id = entry.id
      ) balance ON true
      WHERE entry.workspace_id = ? AND entry.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!entry) throw ApiError.notFound("Lançamento não encontrado.", "LEDGER_ENTRY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(entry.company_id));

    const [installments, confirmations, documents, events] = await Promise.all([
      d1.prepare(`SELECT installment.* FROM fdp_ledger_installments installment
        WHERE installment.workspace_id = ? AND installment.entry_id = ?
        ORDER BY installment.number`).bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT confirmation.id, confirmation.installment_id, confirmation.competence,
          confirmation.amount, confirmation.kind, confirmation.source, confirmation.reference,
          confirmation.justification, confirmation.reverses_confirmation_id, confirmation.confirmed_by,
          confirmation.confirmed_at, member.name AS confirmed_by_name
        FROM fdp_ledger_confirmations confirmation
        LEFT JOIN fdp_users member ON member.id = confirmation.confirmed_by
        WHERE confirmation.workspace_id = ? AND confirmation.entry_id = ?
        ORDER BY confirmation.confirmed_at, confirmation.id`).bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT document.id, document.document_kind, document.filename, document.content_type,
          document.size_bytes, document.created_by, document.created_at
        FROM fdp_ledger_documents document
        WHERE document.workspace_id = ? AND document.entry_id = ?
        ORDER BY document.created_at DESC`).bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT event.id, event.installment_id, event.event_type, event.summary,
          event.payload_json, event.actor_user_id, event.created_at, member.name AS actor_name
        FROM fdp_ledger_events event
        LEFT JOIN fdp_users member ON member.id = event.actor_user_id
        WHERE event.workspace_id = ? AND event.entry_id = ?
        ORDER BY event.created_at DESC, event.id DESC LIMIT 200`).bind(workspace.id, id).all<Record<string, unknown>>(),
    ]);

    return Response.json({
      entry: ledgerEntryFromRow(entry),
      installments: installments.results.map(ledgerInstallmentFromRow),
      confirmations: confirmations.results,
      documents: documents.results,
      events: events.results,
    });
  } catch (error) { return apiError(error); }
}

/**
 * Editar o que ainda pode ser editado.
 *
 * O que muda o dinheiro — valor total, quantidade de parcelas, primeira
 * competência — não é editável depois que o lançamento sai do rascunho. Mudar
 * o total de um empréstimo já aprovado e já parcialmente descontado
 * reescreveria o saldo de uma obrigação em curso; o caminho para isso é a
 * renegociação, que preserva o original.
 *
 * Cancelar exige motivo, e só vale enquanto nada foi confirmado — o trigger do
 * banco recusa apagar parcela confirmada, e aqui a recusa vira uma frase.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.manage", "editar um lançamento");

    const entry = await d1.prepare(`SELECT entry.*, COALESCE(balance.discounted_total, 0) AS discounted_total
      FROM fdp_ledger_entries entry
      LEFT JOIN LATERAL (
        SELECT SUM(installment.discounted_amount) AS discounted_total
        FROM fdp_ledger_installments installment
        WHERE installment.workspace_id = entry.workspace_id AND installment.entry_id = entry.id
      ) balance ON true
      WHERE entry.workspace_id = ? AND entry.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!entry) throw ApiError.notFound("Lançamento não encontrado.", "LEDGER_ENTRY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(entry.company_id));

    const status = String(entry.status);
    const discounted = Number(entry.discounted_total ?? 0);
    const requestId = request.headers.get("x-fila-dp-request-id");

    const cancel = body.cancel === true;
    if (cancel) {
      const reason = cleanText(body.canceledReason, 500);
      if (reason.length < 5) {
        throw ApiError.badRequest("Informe o motivo do cancelamento.", "LEDGER_CANCEL_REASON_REQUIRED");
      }
      if (discounted > 0) {
        throw ApiError.badRequest(
          "Este lançamento já teve desconto confirmado. Estorne as confirmações antes de cancelar, ou renegocie o saldo.",
          "LEDGER_ALREADY_CONFIRMED",
        );
      }
      await d1.batch([
        d1.prepare(`UPDATE fdp_ledger_entries SET status = 'canceled', canceled_reason = ?, updated_by = ?, updated_at = now()
          WHERE workspace_id = ? AND id = ? AND status NOT IN ('canceled', 'settled', 'renegotiated')`)
          .bind(reason, user.id, workspace.id, id),
        /* As parcelas ainda não confirmadas somem da programação junto com o
           lançamento. O trigger recusaria as confirmadas — e o `WHERE` aqui
           impede que a recusa vire erro de banco no lugar de uma frase. */
        d1.prepare(`UPDATE fdp_ledger_installments SET status = 'canceled', updated_at = now()
          WHERE workspace_id = ? AND entry_id = ? AND discounted_amount = 0
            AND status NOT IN ('canceled', 'discounted')`)
          .bind(workspace.id, id),
        d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
          VALUES (?, ?, ?, 'canceled', ?, '{}'::jsonb, ?)`)
          .bind(crypto.randomUUID(), workspace.id, id, reason, user.id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "ledger_entry.canceled", entityType: "ledger_entry", entityId: id,
          before: { status }, after: { status: "canceled" }, metadata: { reason }, requestId,
        }),
      ]);
      return Response.json({ entry: { id, status: "canceled", canceledReason: reason } });
    }

    for (const field of ["totalAmount", "installmentCount", "firstCompetence", "modality", "employeeId", "providerId", "companyId"]) {
      if (body[field] !== undefined && status !== "draft") {
        throw ApiError.badRequest(
          "Valor, parcelas, competência inicial e pessoa só mudam enquanto o lançamento é rascunho. Depois disso, o caminho é a renegociação.",
          "LEDGER_ENTRY_FROZEN",
        );
      }
    }

    const title = cleanText(body.title, 180) || String(entry.title);
    const description = cleanText(body.description, 1000);
    const reason = cleanText(body.reason, 1000);
    const unitLabel = cleanText(body.unitLabel, 120);
    const operationLabel = cleanText(body.operationLabel, 120);
    const details = body.details === undefined
      ? (entry.details_json ?? {}) as Record<string, unknown>
      : parseCategoryDetails(String(entry.category) as LedgerCategory, body.details);

    await d1.batch([
      d1.prepare(`UPDATE fdp_ledger_entries SET title = ?, description = ?, reason = ?,
          unit_label = ?, operation_label = ?, details_json = ?::jsonb, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(title, description, reason, unitLabel, operationLabel, JSON.stringify(details), user.id, workspace.id, id),
      d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'updated', ?, '{}'::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, title, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_entry.updated", entityType: "ledger_entry", entityId: id,
        before: { title: String(entry.title) }, after: { title },
        metadata: { detailKeys: Object.keys(details) }, requestId,
      }),
    ]);
    return Response.json({ entry: { id, title, description, reason, unitLabel, operationLabel, details } });
  } catch (error) { return apiError(error); }
}
