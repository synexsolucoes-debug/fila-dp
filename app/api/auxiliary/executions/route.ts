import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertNoClinicalData, auxiliaryCapability, money, parseAuxiliaryModule, providerTypeForModule, sanitizeAuxiliaryPayload } from "@/lib/auxiliary";
import { cleanText, optionalDate } from "@/lib/registrations";

function referenceCode(value: unknown) {
  const code = cleanText(value, 100).toUpperCase().replace(/[^A-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!code) throw ApiError.badRequest("Informe a referência do lançamento.", "AUXILIARY_REFERENCE_REQUIRED");
  return code;
}

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user); const url = new URL(request.url);
    const moduleType = parseAuxiliaryModule(url.searchParams.get("module")); requireCapability(workspace.role, auxiliaryCapability(moduleType, "read"));
    const companyId = cleanText(url.searchParams.get("companyId"), 120); const cycleId = cleanText(url.searchParams.get("competenceId"), 120);
    const cursor = cleanText(url.searchParams.get("cursor"), 120); const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 1), 100);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ executions: [], nextCursor: null });
    const where = ["e.workspace_id = ?", "e.module_type = ?"]; const values: unknown[] = [workspace.id, moduleType];
    if (!access.unrestricted) { const ids = [...access.companyIds]; where.push(`e.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
    if (companyId) { where.push("e.company_id = ?"); values.push(companyId); } if (cycleId) { where.push("e.payroll_cycle_id = ?"); values.push(cycleId); }
    if (cursor) { where.push("e.id > ?"); values.push(cursor); }
    const result = await d1.prepare(`SELECT e.*, p.legal_name AS provider_legal_name, p.trade_name AS provider_trade_name,
      r.id AS revision_id, r.status AS revision_status, r.input_json, r.output_json
      FROM fdp_auxiliary_executions e
      LEFT JOIN fdp_auxiliary_providers p ON p.workspace_id = e.workspace_id AND p.id = e.provider_id
      JOIN fdp_auxiliary_execution_revisions r ON r.workspace_id = e.workspace_id AND r.execution_id = e.id AND r.revision = e.current_revision
      WHERE ${where.join(" AND ")} ORDER BY e.id LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit);
    return Response.json({ executions: rows, nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const moduleType = parseAuxiliaryModule(body.module); requireCapability(workspace.role, auxiliaryCapability(moduleType, "manage"));
    const companyId = cleanText(body.companyId, 120); const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    const providerId = cleanText(body.providerId, 120) || null; const title = cleanText(body.title, 180); const reference = referenceCode(body.referenceCode);
    if (!companyId || !cycleId || !title) throw ApiError.badRequest("Empresa, competência, referência e título são obrigatórios.", "AUXILIARY_REQUIRED_FIELDS");
    assertNoClinicalData(moduleType, title);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const [cycle, provider, duplicate] = await Promise.all([
      d1.prepare("SELECT id, status FROM fdp_payroll_cycles WHERE workspace_id = ? AND company_id = ? AND id = ?").bind(workspace.id, companyId, cycleId).first<{ id: string; status: string }>(),
      providerId ? d1.prepare("SELECT id, provider_type, status FROM fdp_auxiliary_providers WHERE workspace_id = ? AND id = ?").bind(workspace.id, providerId).first<{ id: string; provider_type: string; status: string }>() : Promise.resolve(null),
      d1.prepare("SELECT id FROM fdp_auxiliary_executions WHERE workspace_id = ? AND reference_code = ?").bind(workspace.id, reference).first(),
    ]);
    if (!cycle) throw ApiError.badRequest("Competência inválida.", "INVALID_AUXILIARY_COMPETENCE");
    if (cycle.status === "closed") throw ApiError.badRequest("A competência está fechada.", "COMPETENCE_CLOSED");
    if (providerId && (!provider || provider.provider_type !== providerTypeForModule(moduleType) || provider.status !== "active")) throw ApiError.badRequest("Fornecedor incompatível ou inativo.", "INVALID_AUXILIARY_PROVIDER");
    if (duplicate) throw new ApiError(409, "AUXILIARY_REFERENCE_CONFLICT", "Já existe um lançamento com esta referência.");
    const sanitized = sanitizeAuxiliaryPayload(moduleType, body.input, body.output); const id = crypto.randomUUID(); const revisionId = crypto.randomUUID();
    const execution = { id, companyId, payrollCycleId: cycleId, providerId, moduleType, referenceCode: reference, title, status: "draft", currentRevision: 1, totalAmount: money(body.totalAmount), dueDate: optionalDate(body.dueDate), ownerUserId: cleanText(body.ownerUserId, 120) || null };
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_auxiliary_executions (id, workspace_id, company_id, payroll_cycle_id, provider_id, module_type, reference_code, title, status, current_revision, total_amount, due_date, owner_user_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)`).bind(id, workspace.id, companyId, cycleId, providerId, moduleType, reference, title, execution.totalAmount, execution.dueDate, execution.ownerUserId, user.id),
      d1.prepare(`INSERT INTO fdp_auxiliary_execution_revisions (id, workspace_id, execution_id, revision, input_json, output_json, status, created_by)
        VALUES (?, ?, ?, 1, ?::jsonb, ?::jsonb, 'draft', ?)`).bind(revisionId, workspace.id, id, JSON.stringify(sanitized.input), JSON.stringify(sanitized.output), user.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "auxiliary_execution.created", entityType: "auxiliary_execution", entityId: id,
        after: execution, metadata: { inputKeys: Object.keys(sanitized.input), outputKeys: Object.keys(sanitized.output), revision: 1 }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ execution, revision: { id: revisionId, revision: 1, status: "draft", ...sanitized } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
