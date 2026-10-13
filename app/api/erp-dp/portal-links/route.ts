import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { payrollEmployee } from "@/lib/erp-payroll-service";
import { createPortalToken, employeePortalLinkStatus, employeePortalUrl, portalExpiryFromDays, portalInstant } from "@/lib/employee-portal";

/**
 * Links do portal do colaborador (§4.37). O link mostra holerites e férias,
 * então gerar e revogar exigem `payroll.manage`. O token só existe na resposta
 * de criação: o banco guarda o hash.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const employeeId = new URL(request.url).searchParams.get("employeeId") ?? "";
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    await payrollEmployee(d1, workspace.id, user.id, workspace.role, employeeId);
    const rows = await d1.prepare(`SELECT id, expires_at, revoked_at, opened_count, last_opened_at, created_at FROM fdp_employee_portal_links
        WHERE workspace_id = ? AND employee_id = ? ORDER BY created_at DESC LIMIT 20`).bind(workspace.id, employeeId).all<Record<string, unknown>>();
    return Response.json({ links: (rows.results ?? []).map((row) => ({
      id: String(row.id), expiresAt: portalInstant(row.expires_at), openedCount: Number(row.opened_count ?? 0),
      lastOpenedAt: row.last_opened_at ? portalInstant(row.last_opened_at) : null, createdAt: portalInstant(row.created_at),
      status: employeePortalLinkStatus({ revoked_at: row.revoked_at as string | null, expires_at: portalInstant(row.expires_at) }),
    })) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.manage");
    const employee = await payrollEmployee(d1, workspace.id, user.id, workspace.role, String(body.employeeId ?? ""));
    const token = createPortalToken(workspace.id);
    const expiresAt = portalExpiryFromDays(body.days ?? 30);
    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_employee_portal_links (id, workspace_id, company_id, employee_id, token_hash, expires_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, workspace.id, employee.companyId, employee.id, token.hash, expiresAt.toISOString(), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "employee.portal_link.created", entityType: "employee", entityId: employee.id,
        before: null, after: { linkId: id, expiresAt: expiresAt.toISOString() },
        metadata: { scope: "company", companyId: employee.companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ link: { id, url: employeePortalUrl(token.token), expiresAt: expiresAt.toISOString() } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
