import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareActivity, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { decidedValueFor, discountStatusFor, epiDiscountDecisionLabels } from "@/lib/epi";
import { epiMoney, epiText, parseDiscountDecision, prepareEpiMovement } from "@/lib/epi-service";
import { validCompetence } from "@/lib/operations";

type RouteContext = { params: Promise<{ id: string }> };

type DiscountRow = {
  id: string; company_id: string; employee_id: string; product_id: string; card_id: string | null;
  title: string; ca_number: string; size: string; quantity: number; unit_value: string | number;
  total_value: string | number; occurred_on: string; trigger_reason: string; status: string; decision: string;
  movement_id: string | null;
};

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar análises de desconto de EPI");
    const discount = await d1.prepare(`SELECT dr.*, p.name AS epi_name, e.full_name AS employee_full_name,
        e.social_name AS employee_social_name, c.trade_name AS company_trade_name, c.legal_name AS company_legal_name,
        c.tax_id AS company_tax_id
      FROM fdp_epi_discount_requests dr
      JOIN fdp_epi_products p ON p.workspace_id = dr.workspace_id AND p.id = dr.product_id
      JOIN fdp_employees e ON e.workspace_id = dr.workspace_id AND e.id = dr.employee_id
      JOIN fdp_companies c ON c.workspace_id = dr.workspace_id AND c.id = dr.company_id
      WHERE dr.workspace_id = ? AND dr.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!discount) throw ApiError.notFound("Análise de desconto não encontrada.", "EPI_DISCOUNT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(discount.company_id));
    const [attachments, movements] = await Promise.all([
      d1.prepare(`SELECT id, attachment_kind, filename, content_type, size_bytes, created_at
        FROM fdp_epi_attachments WHERE workspace_id = ? AND entity_type = 'discount' AND entity_id = ? ORDER BY created_at`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT * FROM fdp_epi_movements WHERE workspace_id = ? AND discount_request_id = ?
        ORDER BY created_at`).bind(workspace.id, id).all<Record<string, unknown>>(),
    ]);
    return Response.json({ discount, attachments: attachments.results, movements: movements.results });
  } catch (error) { return apiError(error); }
}

/**
 * Parecer do Departamento Pessoal.
 *
 * Esta rota grava uma decisão, não um lançamento. Mesmo "descontar integral"
 * produz apenas o valor aprovado e o encaminhamento — quem executa o desconto é
 * a folha, com o registro em mãos. A separação é o ponto central da §7: nenhum
 * caminho automático do módulo tira dinheiro de um salário.
 *
 * `decidedValueFor` impede o par contraditório — "não descontar" com valor, ou
 * "descontar integral" por um valor diferente do EPI —, e o CHECK no banco
 * recusa mesmo que alguém contorne esta rota.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.discount.analyze", "decidir sobre desconto de EPI");
    const before = await d1.prepare("SELECT * FROM fdp_epi_discount_requests WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<DiscountRow>();
    if (!before) throw ApiError.notFound("Análise de desconto não encontrada.", "EPI_DISCOUNT_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, before.company_id);
    if (["refused", "canceled", "finished"].includes(before.status)) {
      throw new ApiError(409, "EPI_DISCOUNT_CLOSED", "Esta análise já foi encerrada e não aceita nova decisão.");
    }

    if (body.cancel === true) {
      const reason = epiText(body.comment, "o motivo do cancelamento", 2000, true);
      await d1.batch([
        d1.prepare(`UPDATE fdp_epi_discount_requests SET status = 'canceled', decision_comment = ?, decided_by = ?,
          decided_at = now(), updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
          .bind(reason, user.id, user.id, workspace.id, id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_discount.canceled",
          entityType: "epi_discount_request", entityId: id, before, after: { status: "canceled", comment: reason },
          requestId: request.headers.get("x-fila-dp-request-id"),
        }),
      ]);
      return Response.json({ discount: { id, status: "canceled" } });
    }

    const decision = parseDiscountDecision(body.decision);
    const total = Number(before.total_value);
    const requested = body.decidedValue === undefined ? 0 : epiMoney(body.decidedValue, "Valor do desconto");
    const decidedValue = decidedValueFor(decision, requested, total);
    if (decision === "partial_discount" && decidedValue <= 0) {
      throw ApiError.badRequest("Informe o valor do desconto parcial.", "EPI_PARTIAL_VALUE_REQUIRED");
    }
    const status = discountStatusFor(decision);
    const comment = epiText(body.comment, "o parecer", 2000, decision === "request_more_info" || decision === "no_discount");
    const createsMovement = decision === "full_discount" || decision === "partial_discount";
    const competence = createsMovement ? validCompetence(body.competence) : "";
    const movementId = createsMovement ? crypto.randomUUID() : null;

    const product = await d1.prepare("SELECT name FROM fdp_epi_products WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, before.product_id).first<{ name: string }>();
    const company = await d1.prepare("SELECT tax_id FROM fdp_companies WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, before.company_id).first<{ tax_id: string }>();
    const employee = await d1.prepare("SELECT full_name, social_name FROM fdp_employees WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, before.employee_id).first<{ full_name: string; social_name: string }>();

    /**
     * O desconto decidido vira **um** lançamento em Adiantamentos e Descontos.
     *
     * É aqui que a etapa de análise do SESMT encontra o controle de saldo: o
     * parecer decide se desconta e quanto; o lançamento passa a responder
     * quanto já foi descontado e quanto falta — que é o que a movimentação
     * sozinha nunca respondeu.
     *
     * A unicidade é do banco: o índice parcial em
     * `(workspace, origin_type, origin_id)` garante que decidir duas vezes a
     * mesma solicitação não crie dois lançamentos. O `WHERE NOT EXISTS` existe
     * para que a segunda decisão não aborte o lote inteiro com violação de
     * chave — ela apenas não insere.
     *
     * Entrega, dano, perda e devolução continuam **não** gerando cobrança:
     * nada disto roda fora de uma decisão explícita de descontar.
     */
    const ledgerEntryId = crypto.randomUUID();
    const criaLancamento = createsMovement && decidedValue > 0;

    await d1.batch([
      ...(movementId ? [d1.prepare(`INSERT INTO fdp_employee_movements
        (id, workspace_id, company_id, employee_id, card_id, movement_type, effective_date, title,
         details_json, status, requested_by)
        VALUES (?, ?, ?, ?, ?, 'epi_discount', ?, ?, ?::jsonb, 'draft', ?)`)
        .bind(movementId, workspace.id, before.company_id, before.employee_id, before.card_id,
          `${competence}-01`, `Desconto de EPI — ${before.title}`,
          JSON.stringify({
            discountRequestId: id, cardId: before.card_id, competence, originalValue: total,
            approvedValue: decidedValue, decision, note: comment, automaticDeduction: false,
          }), user.id)] : []),
      d1.prepare(`UPDATE fdp_epi_discount_requests SET status = ?, decision = ?, decided_value = ?,
        decided_by = ?, decided_at = now(), decision_comment = ?, competence = ?, movement_id = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(status, decision, decidedValue, user.id, comment, competence, movementId, user.id, workspace.id, id),
      ...(criaLancamento ? [
        d1.prepare(`INSERT INTO fdp_ledger_entries
          (id, workspace_id, company_id, employee_id, employment_type_snapshot, department_id, department_label,
           requester_area_id, responsible_area_id, category, title, description, reason,
           occurred_on, requested_on, requested_by, total_amount, modality, installment_count,
           first_competence, expected_end_competence, settlement_target, status, movement_id,
           origin_type, origin_id, details_json, approved_by, approved_at, created_by, updated_by)
          SELECT ?, ?, request.company_id, request.employee_id, COALESCE(employee.employment_type, ''),
            employee.department_id, COALESCE(department.name, ''),
            request.requester_area_id, request.responsible_area_id, 'sesmt_discount',
            ?, ?, request.reason_note,
            request.occurred_on, CURRENT_DATE, ?, ?, 'single', 1,
            ?, ?, 'payroll', 'active', ?,
            'epi_discount', request.id, ?::jsonb, ?, now(), ?, ?
          FROM fdp_epi_discount_requests request
          JOIN fdp_employees employee
            ON employee.workspace_id = request.workspace_id AND employee.id = request.employee_id
          LEFT JOIN fdp_departments department
            ON department.workspace_id = employee.workspace_id AND department.id = employee.department_id
          WHERE request.workspace_id = ? AND request.id = ?
            AND NOT EXISTS (
              SELECT 1 FROM fdp_ledger_entries existing
              WHERE existing.workspace_id = request.workspace_id
                AND existing.origin_type = 'epi_discount' AND existing.origin_id = request.id
            )`)
          .bind(ledgerEntryId, workspace.id,
            `Desconto de EPI — ${before.title}`, comment, user.id, decidedValue,
            competence, competence, movementId,
            JSON.stringify({ incident: before.trigger_reason, item: before.title, movementReference: movementId ?? "" }),
            user.id, user.id, user.id, workspace.id, id),
        /* A parcela única, criada a partir do lançamento que acabou de existir
           — ou do que já existia, numa segunda decisão. */
        d1.prepare(`INSERT INTO fdp_ledger_installments
          (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount)
          SELECT ?, entry.workspace_id, entry.id, entry.company_id, 1, 1, entry.first_competence, entry.total_amount
          FROM fdp_ledger_entries entry
          WHERE entry.workspace_id = ? AND entry.origin_type = 'epi_discount' AND entry.origin_id = ?
          ON CONFLICT (workspace_id, entry_id, number) DO NOTHING`)
          .bind(crypto.randomUUID(), workspace.id, id),
        /* Uma segunda decisão corrige o valor — mas só enquanto nada tiver sido
           descontado. Depois disso o caminho é estorno ou renegociação, e o
           trigger do banco recusaria mexer na parcela confirmada. */
        d1.prepare(`UPDATE fdp_ledger_entries entry
          SET total_amount = ?, first_competence = ?, expected_end_competence = ?, updated_at = now()
          WHERE entry.workspace_id = ? AND entry.origin_type = 'epi_discount' AND entry.origin_id = ?
            AND entry.status IN ('approved', 'active')
            AND NOT EXISTS (
              SELECT 1 FROM fdp_ledger_installments installment
              WHERE installment.workspace_id = entry.workspace_id AND installment.entry_id = entry.id
                AND installment.discounted_amount <> 0
            )`)
          .bind(decidedValue, competence, competence, workspace.id, id),
        d1.prepare(`UPDATE fdp_ledger_installments installment
          SET planned_amount = ?, competence = ?, updated_at = now()
          FROM fdp_ledger_entries entry
          WHERE entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
            AND installment.workspace_id = ? AND entry.origin_type = 'epi_discount' AND entry.origin_id = ?
            AND installment.discounted_amount = 0`)
          .bind(decidedValue, competence, workspace.id, id),
        d1.prepare(`INSERT INTO fdp_ledger_events
          (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
          SELECT ?, ?, entry.id, 'created', ?, ?::jsonb, ?
          FROM fdp_ledger_entries entry
          WHERE entry.workspace_id = ? AND entry.origin_type = 'epi_discount' AND entry.origin_id = ?`)
          .bind(crypto.randomUUID(), workspace.id,
            `Originado da análise de desconto de EPI`,
            JSON.stringify({ discountRequestId: id, decidedValue, competence }), user.id,
            workspace.id, id),
      ] : []),
      prepareEpiMovement({
        workspaceId: workspace.id, companyId: before.company_id, cnpj: company?.tax_id ?? "",
        movementDate: new Date().toISOString().slice(0, 10), movementType: "discount_analysis",
        productId: before.product_id, epiName: product?.name ?? "", caNumber: before.ca_number, size: before.size,
        employeeId: before.employee_id, employeeName: employee ? (employee.social_name || employee.full_name) : "",
        quantity: Number(before.quantity), stockDelta: 0, unitValue: Number(before.unit_value),
        reason: before.trigger_reason, status, generateDpDemand: false, demandId: before.card_id,
        discountRequestId: id, sourceType: "discount", sourceId: id, responsibleId: user.id,
        notes: `${epiDiscountDecisionLabels[decision]}${comment ? `: ${comment}` : ""}`, createdBy: user.id,
      }),
      // A decisão aparece na linha do tempo da própria demanda: quem estiver no
      // quadro vê o desfecho sem precisar abrir o módulo de EPI.
      ...(before.card_id ? [prepareActivity(workspace.id, before.card_id, auth.user.email, "epi.discount.decided", {
        decision, decidedValue, status, discountRequestId: id, competence, movementId,
      })] : []),
      ...(before.card_id && decision === "request_more_info" ? [d1.prepare(`INSERT INTO fdp_card_comments
        (id, workspace_id, card_id, author_user_id, body) VALUES (?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, before.card_id, user.id, comment)] : []),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_discount.decided",
        entityType: "epi_discount_request", entityId: id, before,
        after: { status, decision, decidedValue, comment, competence, movementId },
        metadata: {
          cardId: before.card_id, totalValue: total, employeeId: before.employee_id, automaticDeduction: false,
          ledgerEntryCreated: criaLancamento,
        },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ discount: { id, status, decision, decidedValue, comment, competence, movementId } });
  } catch (error) { return apiError(error); }
}
