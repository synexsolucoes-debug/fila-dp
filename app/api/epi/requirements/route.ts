import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { epiQuantity } from "@/lib/epi-service";

const requirementSelect = `SELECT r.*, p.name AS product_name, p.ca_number, p.ca_expires_on, p.product_expires_on,
  d.name AS department_name, po.name AS position_name
  FROM fdp_epi_requirements r
  JOIN fdp_epi_products p ON p.workspace_id = r.workspace_id AND p.id = r.product_id
  LEFT JOIN fdp_departments d ON d.workspace_id = r.workspace_id AND d.company_id = r.company_id AND d.id = r.department_id
  LEFT JOIN fdp_positions po ON po.workspace_id = r.workspace_id AND po.company_id = r.company_id AND po.id = r.position_id`;

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar regras obrigatórias de EPI");
    const companyId = cleanText(new URL(request.url).searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione a empresa dos colaboradores.", "EPI_REQUIREMENT_COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const [requirements, departments, positions] = await Promise.all([
      d1.prepare(`${requirementSelect} WHERE r.workspace_id = ? AND r.company_id = ?
        ORDER BY r.active DESC, COALESCE(d.name, ''), COALESCE(po.name, ''), p.name`)
        .bind(workspace.id, companyId).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, name, code, status FROM fdp_departments
        WHERE workspace_id = ? AND company_id = ? ORDER BY status, name`)
        .bind(workspace.id, companyId).all<Record<string, unknown>>(),
      d1.prepare(`SELECT id, name, code, status FROM fdp_positions
        WHERE workspace_id = ? AND company_id = ? ORDER BY status, name`)
        .bind(workspace.id, companyId).all<Record<string, unknown>>(),
    ]);
    return Response.json({ requirements: requirements.results, departments: departments.results, positions: positions.results });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.edit", "definir EPIs obrigatórios");
    const row = {
      id: crypto.randomUUID(),
      companyId: cleanText(body.companyId, 120),
      departmentId: cleanText(body.departmentId, 120) || null,
      positionId: cleanText(body.positionId, 120) || null,
      productId: cleanText(body.productId, 120),
      quantity: epiQuantity(body.quantity, "a quantidade obrigatória", { min: 1, max: 100 }),
      replacementDays: epiQuantity(body.replacementDays ?? 0, "o ciclo de troca", { min: 0, max: 3650 }),
      warningDays: epiQuantity(body.warningDays ?? 30, "a antecedência do alerta", { min: 0, max: 365 }),
      notes: cleanText(body.notes, 1000),
    };
    if (!row.companyId || !row.productId) {
      throw ApiError.badRequest("Empresa e EPI são obrigatórios.", "EPI_REQUIREMENT_REQUIRED_FIELDS");
    }
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, row.companyId);
    const [product, department, position, duplicate] = await Promise.all([
      d1.prepare("SELECT id FROM fdp_epi_products WHERE workspace_id = ? AND id = ? AND status <> 'inactive'")
        .bind(workspace.id, row.productId).first(),
      row.departmentId ? d1.prepare("SELECT id FROM fdp_departments WHERE workspace_id = ? AND company_id = ? AND id = ?")
        .bind(workspace.id, row.companyId, row.departmentId).first() : Promise.resolve({ id: "all" }),
      row.positionId ? d1.prepare("SELECT id FROM fdp_positions WHERE workspace_id = ? AND company_id = ? AND id = ?")
        .bind(workspace.id, row.companyId, row.positionId).first() : Promise.resolve({ id: "all" }),
      d1.prepare(`SELECT id FROM fdp_epi_requirements WHERE workspace_id = ? AND company_id = ?
        AND department_id IS NOT DISTINCT FROM ? AND position_id IS NOT DISTINCT FROM ? AND product_id = ?`)
        .bind(workspace.id, row.companyId, row.departmentId, row.positionId, row.productId).first(),
    ]);
    if (!product) throw ApiError.notFound("EPI não encontrado no catálogo do grupo.", "EPI_PRODUCT_NOT_FOUND");
    if (!department) throw ApiError.badRequest("O departamento não pertence à empresa selecionada.", "EPI_REQUIREMENT_DEPARTMENT_INVALID");
    if (!position) throw ApiError.badRequest("O cargo não pertence à empresa selecionada.", "EPI_REQUIREMENT_POSITION_INVALID");
    if (duplicate) throw new ApiError(409, "EPI_REQUIREMENT_CONFLICT", "Já existe uma regra para este EPI, cargo e departamento.");

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_epi_requirements
        (id, workspace_id, company_id, department_id, position_id, product_id, quantity,
         replacement_days, warning_days, active, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .bind(row.id, workspace.id, row.companyId, row.departmentId, row.positionId, row.productId,
          row.quantity, row.replacementDays, row.warningDays, row.notes, user.id, user.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "epi_requirement.created", entityType: "epi_requirement", entityId: row.id, after: row,
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    const created = await d1.prepare(`${requirementSelect} WHERE r.workspace_id = ? AND r.id = ?`)
      .bind(workspace.id, row.id).first<Record<string, unknown>>();
    return Response.json({ requirement: created }, { status: 201 });
  } catch (error) { return apiError(error); }
}
