import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";

type Params = { params: Promise<{ id: string }> };

/** Lista os documentos de todas as competências do contrato do prestador. */
export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.read");
    const provider = await d1.prepare(`SELECT profile.company_id, profile.contract_reference, auxiliary.legal_name
      FROM fdp_contractor_profiles profile
      JOIN fdp_auxiliary_providers auxiliary ON auxiliary.workspace_id = profile.workspace_id AND auxiliary.id = profile.provider_id
      WHERE profile.workspace_id = ? AND profile.provider_id = ?`)
      .bind(workspace.id, id)
      .first<{ company_id: string; contract_reference: string; legal_name: string }>();
    if (!provider) throw ApiError.notFound("Prestador PJ não encontrado.", "CONTRACTOR_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, provider.company_id);

    const documents = await d1.prepare(`SELECT id, closing_id, document_kind, competence, invoice_number,
        filename, content_type, size_bytes, created_at
      FROM fdp_contractor_documents
      WHERE workspace_id = ? AND provider_id = ?
      ORDER BY competence DESC, created_at DESC`)
      .bind(workspace.id, id)
      .all<Record<string, unknown>>();
    return Response.json({
      provider: { id, legalName: provider.legal_name, contractReference: provider.contract_reference },
      documents: documents.results,
    });
  } catch (error) {
    return apiError(error);
  }
}
