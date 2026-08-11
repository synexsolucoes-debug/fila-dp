import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, loadMemberModuleGrants, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { moduleAccessMessages, resolveModules, type ModuleCategory, type ModuleDefinition } from "@/lib/modules";

type Params = { params: Promise<{ id: string }> };

/**
 * Acesso individual de um membro aos módulos do grupo.
 *
 * Existe porque a operação real não cabe em quatro papéis: alguém do fiscal pode
 * precisar de Relatórios sem virar administrador, e um estagiário pode precisar
 * ficar fora de Folha sem perder o resto.
 *
 * Duas direções com significados diferentes, e a tela precisa dizer os dois:
 * bloquear tira o módulo daquela pessoa mesmo que o papel permita; liberar
 * concede a ela a **leitura** do módulo que o papel não daria — as ações de
 * escrita continuam vindo do papel, porque liberar a tela sem as ações
 * entregaria uma tela decorativa, e liberar as ações junto seria promover
 * alguém sem dizer.
 */

async function loadCatalog(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"]) {
  const rows = await d1.prepare(`SELECT key, name, description, category, route, required_capability, depends_on, status, position
    FROM fdp_modules ORDER BY position, key`).all<Record<string, unknown>>();
  return rows.results.map((row): ModuleDefinition => ({
    key: String(row.key), name: String(row.name), description: String(row.description),
    category: String(row.category) as ModuleCategory, route: String(row.route),
    requiredCapability: String(row.required_capability), dependsOn: String(row.depends_on),
    status: String(row.status) === "active" ? "active" : "inactive", position: Number(row.position),
  }));
}

async function loadPlanContext(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"], workspaceId: string) {
  const [planModules, grants, subscription] = await Promise.all([
    d1.prepare(`SELECT pm.module_key FROM fdp_plan_modules pm
      JOIN fdp_workspace_subscriptions s ON s.plan_id = pm.plan_id WHERE s.workspace_id = ?`)
      .bind(workspaceId).all<{ module_key: string }>(),
    d1.prepare("SELECT module_key, granted FROM fdp_workspace_module_grants WHERE workspace_id = ? AND (expires_at IS NULL OR expires_at > now())")
      .bind(workspaceId).all<{ module_key: string; granted: number }>(),
    d1.prepare("SELECT status FROM fdp_workspace_subscriptions WHERE workspace_id = ?")
      .bind(workspaceId).first<{ status: string }>(),
  ]);
  return {
    planModules: new Set(planModules.results.map((row) => String(row.module_key))),
    workspaceGrants: new Map(grants.results.map((row) => [String(row.module_key), Number(row.granted) === 1])),
    subscriptionStatus: String(subscription?.status ?? "inactive"),
  };
}

async function requireMember(d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"], workspaceId: string, userId: string) {
  const member = await d1.prepare(`SELECT m.user_id, m.role, u.name, u.email
    FROM fdp_workspace_members m JOIN fdp_users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND m.user_id = ?`)
    .bind(workspaceId, userId).first<{ user_id: string; role: string; name: string; email: string }>();
  if (!member) throw ApiError.notFound("Este usuário não pertence ao grupo.", "MEMBER_NOT_FOUND");
  return member;
}

export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "members.directory.read");

    const member = await requireMember(d1, workspace.id, id);
    const [catalog, plan, grants] = await Promise.all([
      loadCatalog(d1),
      loadPlanContext(d1, workspace.id),
      loadMemberModuleGrants(d1, workspace.id, id),
    ]);
    const workspaceStatus = String((workspace as Record<string, unknown>).status ?? "active");

    // Duas resoluções: o que o papel daria sozinho e o que a pessoa tem de
    // fato. A diferença entre as duas é exatamente o que a exceção fez — sem
    // isso a tela mostraria o resultado sem mostrar a causa.
    const byRole = resolveModules({
      modules: catalog, ...plan, role: member.role, workspaceStatus,
    });
    const effective = resolveModules({
      modules: catalog, ...plan, memberGrants: grants.byModule, role: member.role, workspaceStatus,
    });
    const roleByKey = new Map(byRole.map((item) => [item.key, item]));

    return Response.json({
      member: { id: member.user_id, name: member.name, email: member.email, role: member.role },
      modules: effective.map((item) => {
        const base = roleByKey.get(item.key);
        const override = grants.byModule.get(item.key);
        return {
          key: item.key,
          name: item.name,
          description: item.description,
          category: item.category,
          allowed: item.allowed,
          reason: item.reason,
          message: moduleAccessMessages[item.reason],
          allowedByRole: base?.allowed ?? false,
          // `null` quando não há exceção: a tela distingue "segue o papel" de
          // "foi decidido individualmente".
          override: override === undefined ? null : override,
          // Fora do plano, nem o administrador do grupo pode liberar.
          lockedByPlan: base?.reason === "not_in_plan" || base?.reason === "revoked_by_platform",
        };
      }),
      permissions: { manage: hasCapability(workspace, "members.manage") },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "members.manage");

    const member = await requireMember(d1, workspace.id, id);
    const moduleKey = cleanText(body.moduleKey, 60);
    if (!moduleKey) throw ApiError.badRequest("Informe o módulo.", "MODULE_REQUIRED");
    const reason = cleanText(body.reason, 300);

    const catalog = await loadCatalog(d1);
    const definition = catalog.find((item) => item.key === moduleKey);
    if (!definition) throw ApiError.notFound("Módulo não encontrado.", "MODULE_NOT_FOUND");

    // `null` remove a exceção e devolve a pessoa ao que o papel dela decide.
    const raw = body.granted;
    const granted = raw === null || raw === undefined || raw === "" ? null : raw === true || raw === "true";

    if (granted !== null) {
      const plan = await loadPlanContext(d1, workspace.id);
      const workspaceStatus = String((workspace as Record<string, unknown>).status ?? "active");
      const byRole = resolveModules({ modules: catalog, ...plan, role: member.role, workspaceStatus });
      const base = byRole.find((item) => item.key === moduleKey);
      // O plano está acima da exceção: liberar para uma pessoa o que o grupo não
      // contratou seria vender por dentro da tela.
      if (granted && (base?.reason === "not_in_plan" || base?.reason === "revoked_by_platform")) {
        throw new ApiError(409, "MODULE_NOT_CONTRACTED",
          `"${definition.name}" não faz parte do plano do grupo. Ajuste o plano antes de liberar para um usuário.`);
      }
    }

    // O administrador não pode se tirar do próprio acesso de gestão: sem isso o
    // grupo pode ficar sem ninguém capaz de devolver a permissão.
    if (granted === false && member.user_id === user.id && definition.requiredCapability === "members.directory.read") {
      throw new ApiError(409, "SELF_LOCKOUT",
        "Você não pode bloquear o próprio acesso a Usuários e permissões. Peça a outro administrador.");
    }

    const previous = await d1.prepare("SELECT granted FROM fdp_member_module_grants WHERE workspace_id = ? AND user_id = ? AND module_key = ?")
      .bind(workspace.id, id, moduleKey).first<{ granted: boolean | number }>();
    const before = previous === null || previous === undefined
      ? null
      : previous.granted === true || Number(previous.granted) === 1;

    const statements = [
      granted === null
        ? d1.prepare("DELETE FROM fdp_member_module_grants WHERE workspace_id = ? AND user_id = ? AND module_key = ?")
          .bind(workspace.id, id, moduleKey)
        : d1.prepare(`INSERT INTO fdp_member_module_grants (workspace_id, user_id, module_key, granted, reason, granted_by)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (workspace_id, user_id, module_key)
            DO UPDATE SET granted = EXCLUDED.granted, reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by, updated_at = now()`)
          .bind(workspace.id, id, moduleKey, granted, reason, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: granted === null ? "member_module.cleared" : granted ? "member_module.granted" : "member_module.denied",
        entityType: "workspace_member", entityId: id,
        before: { moduleKey, granted: before },
        after: { moduleKey, granted },
        metadata: { moduleName: definition.name, targetRole: member.role, reason },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ];
    await d1.batch(statements);

    return Response.json({ moduleKey, granted });
  } catch (error) {
    return apiError(error);
  }
}
