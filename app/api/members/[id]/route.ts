import { ApiError, apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, prepareActivity, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { prepareMemberDepartmentAccess, resolveMemberDepartmentAccess } from "@/lib/member-departments";

type RouteContext = { params: Promise<{ id: string }> };
const memberRoles: WorkspaceRole[] = ["admin", "member", "observer", "guest"];

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { role?: WorkspaceRole; companyIds?: unknown[]; departmentId?: unknown; moduleKeys?: unknown[] };
    if (body.role !== undefined && !memberRoles.includes(body.role)) {
      return Response.json({ error: "Papel de acesso inválido." }, { status: 400 });
    }
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "members.manage");
    const member = await d1.prepare(
      `SELECT u.email, wm.role, CASE WHEN w.owner_user_id = wm.user_id THEN 1 ELSE 0 END AS is_owner
       FROM fdp_workspace_members wm
       JOIN fdp_users u ON u.id = wm.user_id
       JOIN fdp_workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = ? AND wm.user_id = ?`,
    ).bind(workspace.id, id).first<{ email: string; role: WorkspaceRole; is_owner: number }>();
    if (!member) throw ApiError.notFound("Membro não encontrado.", "MEMBER_NOT_FOUND");
    if (Boolean(member.is_owner) && body.role !== undefined && body.role !== "admin") {
      return Response.json({ error: "O proprietário precisa permanecer administrador." }, { status: 400 });
    }
    const currentAccess = await d1.prepare("SELECT company_id FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ? ORDER BY company_id")
      .bind(workspace.id, id).all<{ company_id: string }>();
    const currentDepartment = await d1.prepare(`SELECT am.area_id, a.name
        FROM fdp_area_members am JOIN fdp_areas a ON a.workspace_id = am.workspace_id AND a.id = am.area_id
        WHERE am.workspace_id = ? AND am.user_id = ? AND am.is_primary = 1 AND a.status = 'active'`)
      .bind(workspace.id, id).first<{ area_id: string; name: string }>();
    const departmentAccess = Object.hasOwn(body, "departmentId")
      ? await resolveMemberDepartmentAccess(d1, workspace.id, body.departmentId, body.moduleKeys)
      : null;
    let companyIds: string[] | null = null;
    if (Array.isArray(body.companyIds)) {
      companyIds = [...new Set(body.companyIds.map((companyId) => text(companyId, 120)).filter(Boolean))];
      const validCompanies = companyIds.length
        ? await d1.prepare(`SELECT id FROM fdp_companies WHERE workspace_id = ? AND id IN (${companyIds.map(() => "?").join(",")})`).bind(workspace.id, ...companyIds).all<{ id: string }>()
        : { results: [] as { id: string }[] };
      if (validCompanies.results.length !== companyIds.length) return Response.json({ error: "Uma ou mais empresas selecionadas não pertencem a este grupo." }, { status: 400 });
    }
    const statements: D1PreparedStatement[] = [];
    if (body.role !== undefined) {
      statements.push(d1.prepare("UPDATE fdp_workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?")
        .bind(body.role, workspace.id, id));
    }
    if (companyIds) {
      statements.push(
        d1.prepare("DELETE FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ?").bind(workspace.id, id),
        ...companyIds.map((companyId) => d1.prepare("INSERT INTO fdp_member_company_access (workspace_id, user_id, company_id) VALUES (?, ?, ?)").bind(workspace.id, id, companyId)),
      );
    }
    if (departmentAccess) {
      statements.push(...prepareMemberDepartmentAccess(d1, {
        workspaceId: workspace.id,
        userId: id,
        actorUserId: user.id,
        workspaceRole: body.role ?? member.role,
        access: departmentAccess,
      }));
    }
    const nextCompanyIds = companyIds ?? currentAccess.results.map((row) => String(row.company_id));
    statements.push(
      prepareActivity(workspace.id, null, auth.user.email, "workspace.member_access_changed", { email: member.email, role: body.role ?? null, companyIds }),
      prepareAuditEvent({
        workspaceId: workspace.id,
        actorUserId: user.id,
        actorEmail: auth.user.email,
        action: "workspace.member_access_changed",
        entityType: "workspace_member",
        entityId: id,
        before: {
          role: member.role,
          companyIds: currentAccess.results.map((row) => String(row.company_id)),
          departmentId: currentDepartment?.area_id ?? null,
        },
        after: {
          role: body.role ?? member.role,
          companyIds: nextCompanyIds,
          departmentId: departmentAccess?.department.id ?? currentDepartment?.area_id ?? null,
          moduleKeys: departmentAccess?.selectedModuleKeys,
        },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    );
    await d1.batch(statements);
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "members.manage");
    const member = await d1.prepare(
      `SELECT u.email, CASE WHEN w.owner_user_id = wm.user_id THEN 1 ELSE 0 END AS is_owner
       FROM fdp_workspace_members wm
       JOIN fdp_users u ON u.id = wm.user_id
       JOIN fdp_workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = ? AND wm.user_id = ?`,
    ).bind(workspace.id, id).first<{ email: string; is_owner: number }>();
    if (!member) throw ApiError.notFound("Membro não encontrado.", "MEMBER_NOT_FOUND");
    if (Boolean(member.is_owner)) {
      return Response.json({ error: "O proprietário não pode ser removido." }, { status: 400 });
    }
    if (id === user.id) {
      return Response.json({ error: "Você não pode remover seu próprio acesso por esta tela." }, { status: 400 });
    }
    await d1.batch([
      d1.prepare("DELETE FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?").bind(workspace.id, id),
      d1.prepare("DELETE FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ?").bind(workspace.id, id),
      d1.prepare("UPDATE fdp_user_workspace_preferences SET active_workspace_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active_workspace_id = ?").bind(id, workspace.id),
      prepareActivity(workspace.id, null, auth.user.email, "workspace.member_removed", { email: member.email }),
      prepareAuditEvent({
        workspaceId: workspace.id,
        actorUserId: user.id,
        actorEmail: auth.user.email,
        action: "workspace.member_removed",
        entityType: "workspace_member",
        entityId: id,
        before: { email: member.email },
        after: { removed: true },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
