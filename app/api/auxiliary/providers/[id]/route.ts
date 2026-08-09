import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { auxiliaryCapability, moduleForProviderType, parseProviderType } from "@/lib/auxiliary";
import { cleanText } from "@/lib/registrations";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const current = await d1.prepare("SELECT * FROM fdp_auxiliary_providers WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Fornecedor não encontrado.", "PROVIDER_NOT_FOUND");
    const providerType = parseProviderType(current.provider_type); requireCapability(workspace.role, auxiliaryCapability(moduleForProviderType(providerType), "manage"));
    const legalName = body.legalName === undefined ? String(current.legal_name) : cleanText(body.legalName, 180);
    if (!legalName) throw ApiError.badRequest("Informe a razão social ou nome profissional.", "PROVIDER_NAME_REQUIRED");
    const next = {
      legalName, tradeName: body.tradeName === undefined ? String(current.trade_name) : cleanText(body.tradeName, 180),
      taxId: body.taxId === undefined ? String(current.tax_id) : cleanText(body.taxId, 30), email: body.email === undefined ? String(current.email) : cleanText(body.email, 180),
      phone: body.phone === undefined ? String(current.phone) : cleanText(body.phone, 40), status: body.status === "inactive" ? "inactive" : body.status === "active" ? "active" : String(current.status),
    };
    await d1.batch([
      d1.prepare(`UPDATE fdp_auxiliary_providers SET legal_name = ?, trade_name = ?, tax_id = ?, email = ?, phone = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
        .bind(next.legalName, next.tradeName, next.taxId, next.email, next.phone, next.status, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "auxiliary_provider.updated", entityType: "auxiliary_provider", entityId: id,
        before: { legalName: current.legal_name, status: current.status }, after: { legalName: next.legalName, status: next.status }, metadata: { contactProvided: Boolean(next.email || next.phone), taxIdProvided: Boolean(next.taxId) }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ provider: { id, providerType, code: current.code, ...next } });
  } catch (error) { return apiError(error); }
}
