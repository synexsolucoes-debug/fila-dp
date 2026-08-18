import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import {
  buildEpiCompliance,
  type EpiComplianceEmployeeInput,
  type EpiHoldingInput,
  type EpiRequirementInput,
} from "@/lib/epi-compliance";

type Row = Record<string, unknown>;
const asText = (value: unknown) => value == null ? "" : String(value);
const asNumber = (value: unknown) => Number(value) || 0;

function monthRange(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw ApiError.badRequest("Informe uma competência no formato AAAA-MM.", "EPI_DASHBOARD_MONTH_INVALID");
  }
  const [year, month] = value.split("-").map(Number);
  const from = `${value}-01`;
  const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return { from, next };
}
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "abrir o dashboard de EPI");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione a empresa dos colaboradores.", "EPI_DASHBOARD_COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const month = cleanText(url.searchParams.get("month"), 7) || new Date().toISOString().slice(0, 7);
    const range = monthRange(month);

    const [employeeRows, requirementRows, holdingRows, utilizationRows, monthTotals] = await Promise.all([
      d1.prepare(`SELECT e.id, e.company_id, e.registration_number, e.department_id, e.position_id,
          COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name,
          COALESCE(d.name, '') AS department_name, COALESCE(po.name, '') AS position_name
        FROM fdp_employees e
        LEFT JOIN fdp_departments d ON d.workspace_id = e.workspace_id AND d.company_id = e.company_id AND d.id = e.department_id
        LEFT JOIN fdp_positions po ON po.workspace_id = e.workspace_id AND po.company_id = e.company_id AND po.id = e.position_id
        WHERE e.workspace_id = ? AND e.company_id = ? AND e.employment_status = 'active'
        ORDER BY employee_name LIMIT 2000`).bind(workspace.id, companyId).all<Row>(),
      d1.prepare(`SELECT r.*, p.name AS product_name, p.ca_number, p.ca_expires_on, p.product_expires_on,
          COALESCE(d.name, '') AS department_name, COALESCE(po.name, '') AS position_name,
          COALESCE((SELECT SUM(b.quantity) FROM fdp_stock_balances b
            WHERE b.workspace_id = r.workspace_id AND b.product_id = r.product_id), 0) AS available_quantity
        FROM fdp_epi_requirements r
        JOIN fdp_epi_products p ON p.workspace_id = r.workspace_id AND p.id = r.product_id
        LEFT JOIN fdp_departments d ON d.workspace_id = r.workspace_id AND d.company_id = r.company_id AND d.id = r.department_id
        LEFT JOIN fdp_positions po ON po.workspace_id = r.workspace_id AND po.company_id = r.company_id AND po.id = r.position_id
        WHERE r.workspace_id = ? AND r.company_id = ? AND r.active = 1 AND p.status <> 'inactive'
        ORDER BY p.name`).bind(workspace.id, companyId).all<Row>(),
      d1.prepare(`SELECT d.employee_id, d.product_id, p.name AS product_name,
          SUM(d.quantity - d.settled_quantity) AS quantity, MAX(d.delivered_on) AS last_delivered_on
        FROM fdp_epi_deliveries d
        JOIN fdp_epi_products p ON p.workspace_id = d.workspace_id AND p.id = d.product_id
        WHERE d.workspace_id = ? AND d.company_id = ? AND d.status <> 'canceled'
          AND d.quantity > d.settled_quantity
        GROUP BY d.employee_id, d.product_id, p.name`).bind(workspace.id, companyId).all<Row>(),
      d1.prepare(`WITH events AS (
          SELECT product_id, SUM(quantity) AS delivered, 0::bigint AS returned, 0::bigint AS damaged,
            0::bigint AS disposed, SUM(quantity * unit_value) AS delivered_value
          FROM fdp_epi_deliveries WHERE workspace_id = ? AND company_id = ? AND status <> 'canceled'
            AND delivered_on >= ? AND delivered_on < ? GROUP BY product_id
          UNION ALL
          SELECT product_id, 0, SUM(quantity), 0, 0, 0 FROM fdp_epi_returns
            WHERE workspace_id = ? AND company_id = ? AND returned_on >= ? AND returned_on < ? GROUP BY product_id
          UNION ALL
          SELECT product_id, 0, 0, SUM(quantity), 0, 0 FROM fdp_epi_damages
            WHERE workspace_id = ? AND company_id = ? AND occurred_on >= ? AND occurred_on < ? GROUP BY product_id
          UNION ALL
          SELECT product_id, 0, 0, 0, SUM(quantity), 0 FROM fdp_epi_disposals
            WHERE workspace_id = ? AND company_id = ? AND status = 'disposed'
              AND disposal_date >= ? AND disposal_date < ? GROUP BY product_id
        )
        SELECT p.id AS product_id, p.name AS product_name, SUM(e.delivered) AS delivered,
          SUM(e.returned) AS returned, SUM(e.damaged) AS damaged, SUM(e.disposed) AS disposed,
          SUM(e.delivered_value) AS delivered_value,
          COALESCE((SELECT SUM(b.quantity) FROM fdp_stock_balances b
            WHERE b.workspace_id = p.workspace_id AND b.product_id = p.id), 0) AS available_quantity
        FROM events e JOIN fdp_epi_products p ON p.workspace_id = ? AND p.id = e.product_id
        GROUP BY p.workspace_id, p.id, p.name
        ORDER BY SUM(e.delivered) DESC, p.name LIMIT 20`)
        .bind(
          workspace.id, companyId, range.from, range.next,
          workspace.id, companyId, range.from, range.next,
          workspace.id, companyId, range.from, range.next,
          workspace.id, companyId, range.from, range.next,
          workspace.id,
        ).all<Row>(),
      d1.prepare(`SELECT
          COALESCE(SUM(quantity), 0) AS deliveries,
          COUNT(DISTINCT employee_id) AS employees_served,
          COALESCE(SUM(quantity * unit_value), 0) AS delivered_value,
          COUNT(*) FILTER (WHERE status = 'pending_signature') AS pending_signatures
        FROM fdp_epi_deliveries
        WHERE workspace_id = ? AND company_id = ? AND status <> 'canceled'
          AND delivered_on >= ? AND delivered_on < ?`)
        .bind(workspace.id, companyId, range.from, range.next).first<Row>(),
    ]);

    const employees: EpiComplianceEmployeeInput[] = employeeRows.results.map((row) => ({
      id: asText(row.id), companyId: asText(row.company_id), name: asText(row.employee_name),
      registrationNumber: asText(row.registration_number), departmentId: asText(row.department_id),
      departmentName: asText(row.department_name), positionId: asText(row.position_id), positionName: asText(row.position_name),
    }));
    const requirements: EpiRequirementInput[] = requirementRows.results.map((row) => ({
      id: asText(row.id), companyId: asText(row.company_id), departmentId: asText(row.department_id),
      departmentName: asText(row.department_name), positionId: asText(row.position_id), positionName: asText(row.position_name),
      productId: asText(row.product_id), productName: asText(row.product_name), caNumber: asText(row.ca_number),
      caExpiresOn: asText(row.ca_expires_on).slice(0, 10), productExpiresOn: asText(row.product_expires_on).slice(0, 10),
      quantity: asNumber(row.quantity), replacementDays: asNumber(row.replacement_days), warningDays: asNumber(row.warning_days),
    }));
    const holdings: EpiHoldingInput[] = holdingRows.results.map((row) => ({
      employeeId: asText(row.employee_id), productId: asText(row.product_id), productName: asText(row.product_name),
      quantity: asNumber(row.quantity), lastDeliveredOn: asText(row.last_delivered_on).slice(0, 10),
    }));
    const today = new Date().toISOString().slice(0, 10);
    const compliance = buildEpiCompliance(employees, requirements, holdings, today);

    const available = new Map(requirementRows.results.map((row) => [asText(row.product_id), asNumber(row.available_quantity)]));
    const shortageByProduct = new Map<string, { productId: string; productName: string; missing: number; available: number }>();
    for (const employee of compliance) for (const item of employee.items) {
      if (!item.missingQuantity) continue;
      const current = shortageByProduct.get(item.productId) ?? {
        productId: item.productId, productName: item.productName, missing: 0, available: available.get(item.productId) ?? 0,
      };
      current.missing += item.missingQuantity;
      shortageByProduct.set(item.productId, current);
    }
    const shortages = [...shortageByProduct.values()]
      .map((item) => ({ ...item, shortage: Math.max(item.missing - item.available, 0) }))
      .filter((item) => item.shortage > 0)
      .sort((left, right) => right.shortage - left.shortage);

    return Response.json({
      month,
      canManageRequirements: hasCapability(workspace, "epi.edit"),
      summary: {
        activeEmployees: compliance.length,
        employeesWithRequiredEpi: compliance.filter((item) => item.requiredItems > 0 && item.missingItems === 0).length,
        compliantEmployees: compliance.filter((item) => item.status === "compliant").length,
        missingEmployees: compliance.filter((item) => item.missingItems > 0).length,
        expiredEmployees: compliance.filter((item) => item.expiredItems > 0).length,
        overdueEmployees: compliance.filter((item) => item.overdueItems > 0).length,
        dueSoonEmployees: compliance.filter((item) => item.dueSoonItems > 0).length,
        unconfiguredEmployees: compliance.filter((item) => item.status === "unconfigured").length,
        stockShortages: shortages.length,
        monthlyDeliveries: asNumber(monthTotals?.deliveries),
        monthlyEmployeesServed: asNumber(monthTotals?.employees_served),
        monthlyDeliveredValue: asNumber(monthTotals?.delivered_value),
        monthlyPendingSignatures: asNumber(monthTotals?.pending_signatures),
      },
      employees: compliance,
      utilization: utilizationRows.results,
      shortages,
    });
  } catch (error) { return apiError(error); }
}
