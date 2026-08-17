import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A aba de EPIs do cadastro do colaborador.
 *
 * Uma requisição devolve tudo o que a aba mostra: o que está com a pessoa
 * agora, o que já foi devolvido, as trocas, os descartes, as análises de
 * desconto, os anexos e a linha do tempo completa. Sete chamadas separadas
 * fariam a gaveta abrir em sete etapas, e o histórico — que é o motivo de a aba
 * existir — chegaria por último.
 *
 * A trilha vem do razão append-only: é a mesma fonte dos relatórios, então a
 * aba e o relatório nunca discordam.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar os EPIs do colaborador");
    const employee = await d1.prepare(`SELECT e.id, e.company_id, e.full_name, e.social_name, e.registration_number,
        c.legal_name AS company_legal_name, c.trade_name AS company_trade_name, c.tax_id AS company_tax_id
      FROM fdp_employees e
      JOIN fdp_companies c ON c.workspace_id = e.workspace_id AND c.id = e.company_id
      WHERE e.workspace_id = ? AND e.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "EPI_EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(employee.company_id));

    const [deliveries, returns, damages, disposals, discounts, movements, attachments] = await Promise.all([
      d1.prepare(`SELECT d.*, p.name AS epi_name, p.epi_type,
          (SELECT COUNT(*) FROM fdp_epi_attachments a WHERE a.workspace_id = d.workspace_id AND a.entity_type = 'delivery' AND a.entity_id = d.id) AS attachments_count
        FROM fdp_epi_deliveries d
        JOIN fdp_epi_products p ON p.workspace_id = d.workspace_id AND p.id = d.product_id
        WHERE d.workspace_id = ? AND d.employee_id = ? ORDER BY d.delivered_on DESC, d.id DESC LIMIT 200`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT r.*, p.name AS epi_name FROM fdp_epi_returns r
        JOIN fdp_epi_products p ON p.workspace_id = r.workspace_id AND p.id = r.product_id
        WHERE r.workspace_id = ? AND r.employee_id = ? ORDER BY r.returned_on DESC, r.id DESC LIMIT 200`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT dm.*, p.name AS epi_name, rp.name AS replacement_epi_name FROM fdp_epi_damages dm
        JOIN fdp_epi_products p ON p.workspace_id = dm.workspace_id AND p.id = dm.product_id
        LEFT JOIN fdp_epi_products rp ON rp.workspace_id = dm.workspace_id AND rp.id = dm.replacement_product_id
        WHERE dm.workspace_id = ? AND dm.employee_id = ? ORDER BY dm.occurred_on DESC, dm.id DESC LIMIT 200`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT dp.*, p.name AS epi_name FROM fdp_epi_disposals dp
        JOIN fdp_epi_products p ON p.workspace_id = dp.workspace_id AND p.id = dp.product_id
        WHERE dp.workspace_id = ? AND dp.employee_id = ? ORDER BY dp.disposal_date DESC, dp.id DESC LIMIT 200`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT dr.*, p.name AS epi_name, card.title AS demand_title FROM fdp_epi_discount_requests dr
        JOIN fdp_epi_products p ON p.workspace_id = dr.workspace_id AND p.id = dr.product_id
        LEFT JOIN fdp_cards card ON card.workspace_id = dr.workspace_id AND card.id = dr.card_id
        WHERE dr.workspace_id = ? AND dr.employee_id = ? ORDER BY dr.occurred_on DESC, dr.id DESC LIMIT 200`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT * FROM fdp_epi_movements WHERE workspace_id = ? AND employee_id = ?
        ORDER BY movement_date DESC, created_at DESC LIMIT 300`)
        .bind(workspace.id, id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT a.id, a.entity_type, a.entity_id, a.attachment_kind, a.filename, a.content_type,
          a.size_bytes, a.created_at
        FROM fdp_epi_attachments a
        WHERE a.workspace_id = ? AND (
          (a.entity_type = 'delivery' AND a.entity_id IN (SELECT id FROM fdp_epi_deliveries WHERE workspace_id = ? AND employee_id = ?))
          OR (a.entity_type = 'return' AND a.entity_id IN (SELECT id FROM fdp_epi_returns WHERE workspace_id = ? AND employee_id = ?))
          OR (a.entity_type = 'damage' AND a.entity_id IN (SELECT id FROM fdp_epi_damages WHERE workspace_id = ? AND employee_id = ?))
          OR (a.entity_type = 'discount' AND a.entity_id IN (SELECT id FROM fdp_epi_discount_requests WHERE workspace_id = ? AND employee_id = ?))
        ) ORDER BY a.created_at DESC LIMIT 200`)
        .bind(workspace.id, workspace.id, id, workspace.id, id, workspace.id, id, workspace.id, id)
        .all<Record<string, unknown>>(),
    ]);

    const active = deliveries.results.filter((row) =>
      String(row.status) !== "canceled" && Number(row.quantity) - Number(row.settled_quantity) > 0);

    return Response.json({
      employee,
      permissions: {
        deliver: hasCapability(workspace, "epi.deliver"),
        receiveReturn: hasCapability(workspace, "epi.return"),
        damage: hasCapability(workspace, "epi.damage"),
        analyzeDiscount: hasCapability(workspace, "epi.discount.analyze"),
      },
      deliveries: deliveries.results,
      activeDeliveries: active,
      returns: returns.results,
      damages: damages.results,
      disposals: disposals.results,
      discounts: discounts.results,
      movements: movements.results,
      attachments: attachments.results,
    });
  } catch (error) { return apiError(error); }
}
