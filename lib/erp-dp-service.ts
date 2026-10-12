import { getCompanyAccessScope, requireCompanyAccess } from "./fila-dp-db";
import type { WorkspaceRole } from "./fila-dp-types";

/**
 * ERP DP: o recorte de empresa que toda leitura do modo ERP aplica.
 *
 * Mesma regra das listas do produto (`GET /api/operations/movements`):
 * administrador vê o grupo inteiro; os demais, só as empresas liberadas a
 * eles. Com `companyId`, o acesso àquela empresa é exigido antes.
 * `null` quer dizer "nenhuma empresa no escopo" — a rota devolve vazio.
 */
export async function companyScopeClause(
  d1: SqlDatabase, workspaceId: string, userId: string, role: WorkspaceRole, companyId: string, column: string,
): Promise<{ clause: string; values: string[] } | null> {
  if (companyId) {
    await requireCompanyAccess(d1, workspaceId, userId, role, companyId);
    return { clause: `${column} = ?`, values: [companyId] };
  }
  const access = await getCompanyAccessScope(d1, workspaceId, userId, role);
  if (access.unrestricted) return { clause: "TRUE", values: [] };
  const ids = [...access.companyIds];
  if (!ids.length) return null;
  return { clause: `${column} IN (${ids.map(() => "?").join(", ")})`, values: ids };
}
