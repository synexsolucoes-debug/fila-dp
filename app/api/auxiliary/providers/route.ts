import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { auxiliaryCapability, moduleForProviderType, parseProviderType, sanitizeProviderCode } from "@/lib/auxiliary";
import { cleanText } from "@/lib/registrations";

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    const providerType = parseProviderType(new URL(request.url).searchParams.get("providerType"));
    requireCapability(workspace.role, auxiliaryCapability(moduleForProviderType(providerType), "read"));
    const result = await d1.prepare(`SELECT id, provider_type, code, legal_name, trade_name, tax_id, email, phone, status, created_at, updated_at
      FROM fdp_auxiliary_providers WHERE workspace_id = ? AND provider_type = ? ORDER BY status, legal_name`)
      .bind(workspace.id, providerType).all();
    return Response.json({ providers: result.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const providerType = parseProviderType(body.providerType);
    requireCapability(workspace.role, auxiliaryCapability(moduleForProviderType(providerType), "manage"));
    const code = sanitizeProviderCode(body.code); const legalName = cleanText(body.legalName, 180);
    if (!legalName) throw ApiError.badRequest("Informe a razão social ou nome profissional.", "PROVIDER_NAME_REQUIRED");
    if (await d1.prepare("SELECT id FROM fdp_auxiliary_providers WHERE workspace_id = ? AND code = ?").bind(workspace.id, code).first()) {
      throw new ApiError(409, "PROVIDER_CODE_CONFLICT", "Já existe um fornecedor com este código.");
    }
    const id = crypto.randomUUID();
    const provider = { id, providerType, code, legalName, tradeName: cleanText(body.tradeName, 180), taxId: cleanText(body.taxId, 30), email: cleanText(body.email, 180), phone: cleanText(body.phone, 40), status: "active" };
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, trade_name, tax_id, email, phone, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`).bind(id, workspace.id, providerType, code, provider.legalName, provider.tradeName, provider.taxId, provider.email, provider.phone),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "auxiliary_provider.created", entityType: "auxiliary_provider", entityId: id,
        after: { id, providerType, code, legalName, status: "active" }, metadata: { contactProvided: Boolean(provider.email || provider.phone), taxIdProvided: Boolean(provider.taxId) }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ provider }, { status: 201 });
  } catch (error) { return apiError(error); }
}
