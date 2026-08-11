import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertNoClinicalData, auxiliaryCapability, money, parseAuxiliaryModule, providerTypeForModule, sanitizeAuxiliaryPayload } from "@/lib/auxiliary";
import { cleanText, optionalDate } from "@/lib/registrations";

function jsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { return {}; } }
  return {};
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const execution = await d1.prepare(`SELECT e.*, p.legal_name AS provider_legal_name, p.trade_name AS provider_trade_name
      FROM fdp_auxiliary_executions e LEFT JOIN fdp_auxiliary_providers p ON p.workspace_id = e.workspace_id AND p.id = e.provider_id
      WHERE e.workspace_id = ? AND e.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!execution) throw ApiError.notFound("Lançamento auxiliar não encontrado.", "AUXILIARY_EXECUTION_NOT_FOUND");
    const moduleType = parseAuxiliaryModule(execution.module_type); requireCapability(workspace, auxiliaryCapability(moduleType, "read"));
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(execution.company_id));
    const [revisions, approvals] = await Promise.all([
      d1.prepare("SELECT * FROM fdp_auxiliary_execution_revisions WHERE workspace_id = ? AND execution_id = ? ORDER BY revision DESC").bind(workspace.id, id).all(),
      d1.prepare(`SELECT a.*, u.name AS approver_name, u.email AS approver_email, (a.approver_user_id = ?) AS can_decide
        FROM fdp_auxiliary_approval_steps a JOIN fdp_users u ON u.id = a.approver_user_id
        WHERE a.workspace_id = ? AND a.execution_id = ? ORDER BY a.sequence DESC`).bind(user.id, workspace.id, id).all(),
    ]);
    return Response.json({ execution, revisions: revisions.results, approvals: approvals.results });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>; const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const current = await d1.prepare(`SELECT e.*, r.id AS revision_id, r.input_json, r.output_json, r.status AS revision_status
      FROM fdp_auxiliary_executions e JOIN fdp_auxiliary_execution_revisions r ON r.workspace_id = e.workspace_id AND r.execution_id = e.id AND r.revision = e.current_revision
      WHERE e.workspace_id = ? AND e.id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Lançamento auxiliar não encontrado.", "AUXILIARY_EXECUTION_NOT_FOUND");
    const moduleType = parseAuxiliaryModule(current.module_type); requireCapability(workspace, auxiliaryCapability(moduleType, "manage"));
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(current.company_id));
    if (current.status !== "draft" || current.revision_status !== "draft") throw ApiError.badRequest("Crie uma nova revisão para alterar um lançamento já enviado.", "AUXILIARY_REVISION_REQUIRED");
    const providerId = body.providerId === undefined ? (current.provider_id ? String(current.provider_id) : null) : cleanText(body.providerId, 120) || null;
    if (providerId) {
      const provider = await d1.prepare("SELECT provider_type, status FROM fdp_auxiliary_providers WHERE workspace_id = ? AND id = ?").bind(workspace.id, providerId).first<{ provider_type: string; status: string }>();
      if (!provider || provider.provider_type !== providerTypeForModule(moduleType) || provider.status !== "active") throw ApiError.badRequest("Fornecedor incompatível ou inativo.", "INVALID_AUXILIARY_PROVIDER");
    }
    const title = body.title === undefined ? String(current.title) : cleanText(body.title, 180); if (!title) throw ApiError.badRequest("Informe o título.", "AUXILIARY_TITLE_REQUIRED");
    assertNoClinicalData(moduleType, title);
    const sanitized = sanitizeAuxiliaryPayload(moduleType, body.input === undefined ? jsonObject(current.input_json) : body.input, body.output === undefined ? jsonObject(current.output_json) : body.output);
    const totalAmount = body.totalAmount === undefined ? Number(current.total_amount) : money(body.totalAmount);
    const dueDate = body.dueDate === undefined ? (current.due_date ? String(current.due_date) : null) : optionalDate(body.dueDate);
    const ownerUserId = body.ownerUserId === undefined ? (current.owner_user_id ? String(current.owner_user_id) : null) : cleanText(body.ownerUserId, 120) || null;
    await d1.batch([
      d1.prepare(`UPDATE fdp_auxiliary_executions SET provider_id = ?, title = ?, total_amount = ?, due_date = ?, owner_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND status = 'draft'`)
        .bind(providerId, title, totalAmount, dueDate, ownerUserId, workspace.id, id),
      d1.prepare(`UPDATE fdp_auxiliary_execution_revisions SET input_json = ?::jsonb, output_json = ?::jsonb WHERE workspace_id = ? AND id = ? AND status = 'draft'`)
        .bind(JSON.stringify(sanitized.input), JSON.stringify(sanitized.output), workspace.id, current.revision_id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "auxiliary_execution.updated", entityType: "auxiliary_execution", entityId: id,
        before: { title: current.title, totalAmount: Number(current.total_amount), dueDate: current.due_date }, after: { title, totalAmount, dueDate }, metadata: { inputKeys: Object.keys(sanitized.input), outputKeys: Object.keys(sanitized.output), revision: current.current_revision }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ execution: { id, moduleType, providerId, title, totalAmount, dueDate, ownerUserId, status: "draft", currentRevision: Number(current.current_revision) }, revision: { id: current.revision_id, revision: Number(current.current_revision), status: "draft", ...sanitized } });
  } catch (error) { return apiError(error); }
}
