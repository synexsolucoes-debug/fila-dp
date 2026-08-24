import type { WorkspaceRole } from "./fila-dp-types";
import { getCompanyAccessScope, type getWorkspaceContext } from "./fila-dp-db";
import { ApiError } from "./api-errors";

type WorkspaceD1 = Awaited<ReturnType<typeof getWorkspaceContext>>["d1"];

/** Garante que processos restritos pertençam a ao menos uma empresa visível. */
export async function requireProcessCompanyAccess(
  d1: WorkspaceD1,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  processId: string,
  isCorporate: boolean,
) {
  const access = await getCompanyAccessScope(d1, workspaceId, userId, role);
  if (access.unrestricted || isCorporate) return;
  const rows = await d1.prepare("SELECT company_id FROM fdp_process_companies WHERE workspace_id = ? AND process_id = ?")
    .bind(workspaceId, processId)
    .all<{ company_id: string }>();
  if (!rows.results.some((row) => access.companyIds.has(String(row.company_id)))) {
    throw ApiError.forbidden("Você não tem acesso às empresas relacionadas a este processo.", "COMPANY_ACCESS_REQUIRED");
  }
}
