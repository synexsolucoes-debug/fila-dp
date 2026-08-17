import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as { members?: Array<Record<string, unknown>> };
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "departments.manage_members", "gerenciar integrantes da área");
    const area = await d1.prepare("SELECT id, status FROM fdp_areas WHERE workspace_id = ? AND id = ?").bind(workspace.id, id).first<{ id: string; status: string }>();
    if (!area) throw ApiError.notFound("Área não encontrada.", "AREA_NOT_FOUND");
    if (area.status === "archived") throw new ApiError(409, "AREA_ARCHIVED", "Uma área arquivada não aceita alterações de integrantes.");
    const members = (Array.isArray(body.members) ? body.members : []).slice(0, 500).map((item) => ({
      userId: cleanText(item.userId, 120), role: cleanText(item.role, 20) || "member", isPrimary: Boolean(item.isPrimary),
    }));
    if (members.some((item) => !item.userId || !["manager", "member", "observer"].includes(item.role))) {
      throw ApiError.badRequest("Integrante ou papel de área inválido.", "AREA_MEMBER_INVALID");
    }
    if (new Set(members.map((item) => item.userId)).size !== members.length) {
      throw ApiError.badRequest("O mesmo usuário foi informado mais de uma vez.", "AREA_MEMBER_DUPLICATE");
    }
    if (members.length) {
      const found = await d1.prepare(`SELECT user_id FROM fdp_workspace_members WHERE workspace_id = ? AND user_id IN (${members.map(() => "?").join(",")})`)
        .bind(workspace.id, ...members.map((item) => item.userId)).all<{ user_id: string }>();
      if (found.results.length !== members.length) throw ApiError.badRequest("Todos os integrantes precisam pertencer ao grupo.", "AREA_MEMBER_NOT_IN_WORKSPACE");
    }
    await d1.batch([
      ...members.filter((item) => item.isPrimary).map((item) => d1.prepare("UPDATE fdp_area_members SET is_primary = 0, updated_at = now() WHERE workspace_id = ? AND user_id = ?")
        .bind(workspace.id, item.userId)),
      d1.prepare("DELETE FROM fdp_area_members WHERE workspace_id = ? AND area_id = ?").bind(workspace.id, id),
      ...members.map((item) => d1.prepare(`INSERT INTO fdp_area_members
        (id, workspace_id, area_id, user_id, role, is_primary, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, item.userId, item.role, item.isPrimary ? 1 : 0, user.id)),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "area.members_updated", entityType: "area", entityId: id,
        after: { members: members.map((item) => ({ userId: item.userId, role: item.role, isPrimary: item.isPrimary })) },
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ members });
  } catch (error) { return apiError(error); }
}
