import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceModules, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { areaCode, areaModuleList, areaName } from "@/lib/areas";

export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "departments.view", "consultar áreas operacionais");
    const [areas, modules] = await Promise.all([
      d1.prepare(`SELECT a.*,
        COALESCE((SELECT COUNT(*) FROM fdp_area_members am WHERE am.workspace_id = a.workspace_id AND am.area_id = a.id), 0) AS members_count,
        COALESCE((SELECT jsonb_agg(ma.module_key ORDER BY ma.module_key) FROM fdp_area_module_assignments ma
          WHERE ma.workspace_id = a.workspace_id AND ma.area_id = a.id), '[]'::jsonb) AS module_keys
        FROM fdp_areas a WHERE a.workspace_id = ? ORDER BY (a.status = 'active') DESC, a.name`)
        .bind(workspace.id).all<Record<string, unknown>>(),
      // A associação descreve a estrutura do grupo, não o acesso individual de
      // quem abriu a tela. O papel administrativo resolve plano, dependências e
      // bloqueios do workspace sem esconder módulos que outro membro não vê.
      getWorkspaceModules(d1, workspace.id, "admin", String((workspace as Record<string, unknown>).status ?? "active")),
    ]);
    return Response.json({
      areas: areas.results,
      modules: modules.map((module) => ({
        key: module.key, name: module.name, description: module.description, category: module.category,
        route: module.route, status: module.status, available: module.allowed, message: module.message,
      })),
    });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "departments.create", "criar áreas operacionais");
    const area = {
      id: crypto.randomUUID(), name: areaName(body.name), code: areaCode(body.code),
      description: cleanText(body.description, 1000), managerUserId: cleanText(body.managerUserId, 120) || null,
      color: cleanText(body.color, 20) || "#475569", icon: cleanText(body.icon, 40) || "building-2",
      defaultSlaDays: Math.min(Math.max(Math.trunc(Number(body.defaultSlaDays ?? 3)), 0), 365),
    };
    const catalog = await d1.prepare("SELECT key FROM fdp_modules").all<{ key: string }>();
    const modules = areaModuleList(body.moduleKeys, catalog.results.map((item) => String(item.key)));
    const duplicate = await d1.prepare("SELECT id FROM fdp_areas WHERE workspace_id = ? AND code = ?")
      .bind(workspace.id, area.code).first();
    if (duplicate) throw new ApiError(409, "AREA_CODE_CONFLICT", "Já existe uma área com este código.");
    if (area.managerUserId) {
      const member = await d1.prepare("SELECT user_id FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?")
        .bind(workspace.id, area.managerUserId).first();
      if (!member) throw ApiError.badRequest("O responsável precisa ser integrante deste grupo.", "AREA_MANAGER_NOT_MEMBER");
    }
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_areas
        (id, workspace_id, name, code, description, manager_user_id, color, icon, default_sla_days, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(area.id, workspace.id, area.name, area.code, area.description, area.managerUserId,
          area.color, area.icon, area.defaultSlaDays, user.id, user.id),
      ...modules.map((moduleKey) => d1.prepare(`INSERT INTO fdp_area_module_assignments
        (workspace_id, module_key, area_id, created_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, module_key) DO UPDATE SET area_id = EXCLUDED.area_id, updated_at = now()`)
        .bind(workspace.id, moduleKey, area.id, user.id)),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "area.created", entityType: "area", entityId: area.id, after: { ...area, moduleKeys: modules },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ area: { ...area, status: "active", moduleKeys: modules } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
