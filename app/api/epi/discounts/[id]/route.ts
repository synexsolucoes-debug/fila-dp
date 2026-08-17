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
        metadata: { cardId: before.card_id, totalValue: total, employeeId: before.employee_id, automaticDeduction: false },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ discount: { id, status, decision, decidedValue, comment, competence, movementId } });
  } catch (error) { return apiError(error); }
}
