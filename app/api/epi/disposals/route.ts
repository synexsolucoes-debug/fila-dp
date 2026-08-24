import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import {
  attachmentIds, epiDate, epiQuantity, epiText, loadCompany, loadEmployee, loadProduct, loadStockLocation,
  parseDisposalReason, prepareEpiMovement, verifiedAttachments,
} from "@/lib/epi-service";

/**
 * Janela de descarte.
 *
 * A lista traz o que a devolução e a troca já encaminharam para cá, em
 * "Aguardando descarte", mais o que for aberto à mão a partir do estoque. O
 * descarte não é confirmado nesta rota — confirmar é ato separado, com
 * responsável e data próprios, em `POST /api/epi/disposals/[id]`.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar a janela de descarte");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) {
      return Response.json({ disposals: [], disposable: [], nextCursor: null });
    }

    const where = ["dp.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`dp.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids);
    }
    if (companyId) { where.push("dp.company_id = ?"); values.push(companyId); }
    const status = cleanText(url.searchParams.get("status"), 40);
    if (status) { where.push("dp.status = ?"); values.push(status); }
    const reason = cleanText(url.searchParams.get("reason"), 60);
    if (reason) { where.push("dp.disposal_reason = ?"); values.push(reason); }
    const from = epiDate(url.searchParams.get("from"), "a data inicial", false);
    if (from) { where.push("dp.disposal_date >= ?"); values.push(from); }
    const to = epiDate(url.searchParams.get("to"), "a data final", false);
    if (to) { where.push("dp.disposal_date <= ?"); values.push(to); }
    const cursor = cleanText(url.searchParams.get("cursor"), 120);
    if (cursor) { where.push("dp.id > ?"); values.push(cursor); }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

    const disposals = await d1.prepare(`SELECT dp.*, p.name AS epi_name, p.epi_type,
        e.full_name AS employee_full_name, e.social_name AS employee_social_name,
        c.trade_name AS company_trade_name, c.legal_name AS company_legal_name, c.tax_id AS company_tax_id,
        (SELECT COUNT(*) FROM fdp_epi_attachments a WHERE a.workspace_id = dp.workspace_id AND a.entity_type = 'disposal' AND a.entity_id = dp.id) AS attachments_count
      FROM fdp_epi_disposals dp
      JOIN fdp_epi_products p ON p.workspace_id = dp.workspace_id AND p.id = dp.product_id
      LEFT JOIN fdp_employees e ON e.workspace_id = dp.workspace_id AND e.id = dp.employee_id
      JOIN fdp_companies c ON c.workspace_id = dp.workspace_id AND c.id = dp.company_id
      WHERE ${where.join(" AND ")} ORDER BY dp.id LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = disposals.results.slice(0, limit);

    // Estoque em estado que pede descarte e que ainda não tem registro aberto:
    // é o que faz a janela mostrar o problema antes de alguém abrir o chamado.
    const stockWhere = ["p.workspace_id = ?", "p.status IN ('damaged', 'lost', 'discarded')"];
    const stockValues: unknown[] = [workspace.id];
    const disposable = await d1.prepare(`SELECT p.id, p.name, p.ca_number, p.size, p.status,
        p.stock_quantity, p.unit_value, p.ca_expires_on
      FROM fdp_epi_products p
      WHERE ${stockWhere.join(" AND ")}
        AND NOT EXISTS (SELECT 1 FROM fdp_epi_disposals d
          WHERE d.workspace_id = p.workspace_id AND d.product_id = p.id AND d.status = 'awaiting_disposal')
      ORDER BY p.name LIMIT 100`).bind(...stockValues).all<Record<string, unknown>>();

    return Response.json({
      disposals: rows,
      disposable: disposable.results,
      nextCursor: disposals.results.length > limit ? String(rows.at(-1)?.id) : null,
    });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.dispose", "abrir descarte de EPI");
    const companyId = epiText(body.companyId, "a empresa", 120, true);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const [company, product] = await Promise.all([
      loadCompany(d1, workspace.id, companyId),
      loadProduct(d1, workspace.id, epiText(body.productId, "o EPI", 120, true)),
    ]);
    const employeeId = epiText(body.employeeId, "o colaborador", 120) || null;
    const employee = employeeId ? await loadEmployee(d1, workspace.id, companyId, employeeId) : null;

    const quantity = epiQuantity(body.quantity, "Quantidade");
    const disposalDate = epiDate(body.disposalDate, "a data do descarte") as string;
    const disposalReason = parseDisposalReason(body.disposalReason);
    const notes = epiText(body.notes, "a observação", 2000);
    const attachments = await verifiedAttachments(d1, workspace.id, attachmentIds(body.attachmentIds));
    const location = await loadStockLocation(d1, workspace.id, epiText(body.stockLocationId, "o local de estoque", 120));
    const idempotencyKey = epiText(request.headers.get("idempotency-key") ?? body.idempotencyKey, "a chave de idempotência", 160);
    if (idempotencyKey) {
      const replay = await d1.prepare("SELECT * FROM fdp_epi_disposals WHERE workspace_id = ? AND idempotency_key = ?")
        .bind(workspace.id, idempotencyKey).first<Record<string, unknown>>();
      if (replay) return Response.json({ disposal: replay, replayed: true });
    }
    const locationBalance = await d1.prepare(`SELECT quantity FROM fdp_stock_balances
      WHERE workspace_id = ? AND product_id = ? AND stock_location_id = ?`)
      .bind(workspace.id, product.id, location.id).first<{ quantity: number }>();
    // Descarte aberto manualmente sai do estoque, então a quantidade precisa
    // caber nele. O que veio de devolução ou troca já saiu na entrega.
    if (quantity > Number(locationBalance?.quantity ?? 0)) {
      throw ApiError.badRequest(
        `O local ${location.name} tem ${Number(locationBalance?.quantity ?? 0)} unidade(s), menos do que a quantidade informada para descarte.`,
        "EPI_INSUFFICIENT_STOCK",
      );
    }

    const disposal = {
      id: crypto.randomUUID(), companyId, productId: product.id, employeeId, disposalDate, quantity,
      caNumber: epiText(body.caNumber, "o CA", 40) || product.ca_number,
      size: epiText(body.size, "o tamanho", 40) || product.size,
      disposalReason, responsibleUserId: epiText(body.responsibleUserId, "o responsável", 120) || user.id,
      status: "awaiting_disposal" as const, notes,
    };
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_epi_disposals
        (id, workspace_id, company_id, product_id, employee_id, disposal_date, quantity, ca_number, size,
         disposal_reason, responsible_user_id, status, origin_type, notes, created_by, updated_by,
         stock_location_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_disposal', 'manual', ?, ?, ?, ?, ?)`)
        .bind(disposal.id, workspace.id, companyId, product.id, employeeId, disposalDate, quantity,
          disposal.caNumber, disposal.size, disposalReason, disposal.responsibleUserId, notes, user.id, user.id,
          location.id, idempotencyKey),
      prepareEpiMovement({
        workspaceId: workspace.id, companyId, cnpj: company.tax_id, movementDate: disposalDate,
        movementType: "disposal", productId: product.id, epiName: product.name, caNumber: disposal.caNumber,
        size: disposal.size, employeeId, employeeName: employee ? (employee.social_name || employee.full_name) : "",
        quantity, stockDelta: 0, unitValue: Number(product.unit_value), reason: disposalReason,
        status: "awaiting_disposal", sourceType: "disposal", sourceId: disposal.id,
        responsibleId: disposal.responsibleUserId, attachments, notes, createdBy: user.id,
        stockLocationId: location.id, idempotencyKey: idempotencyKey ? `${idempotencyKey}:movement` : "",
      }),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_disposal.created",
        entityType: "epi_disposal", entityId: disposal.id, after: disposal,
        metadata: { origin: "manual", attachments: attachments.length },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ disposal }, { status: 201 });
  } catch (error) { return apiError(error); }
}
