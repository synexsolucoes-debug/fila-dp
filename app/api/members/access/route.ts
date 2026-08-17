import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";

export const dynamic = "force-dynamic";

type MemberRow = {
  user_id: string; email: string; name: string; role: string; joined_at: string;
  is_owner: boolean | number; is_activated: boolean | number;
  status: string | null; status_reason: string | null;
  last_seen_at: string | null; company_ids: string | null;
  department_id: string | null; department_name: string | null;
};

/**
 * Dados da tela de usuários e permissões.
 *
 * O painel já trazia a lista de membros dentro do retrato geral do workspace,
 * mas sem o que uma revisão de acesso exige: quantos assentos o plano concede,
 * quantos estão em uso, quem nunca entrou e há quanto tempo cada pessoa acessou.
 * Sem isso o administrador não consegue responder "quem ainda precisa disso?".
 */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "members.directory.read");

    const [members, seats, companies, departments] = await Promise.all([
      d1.prepare(`SELECT wm.user_id, u.email, u.name, wm.role, wm.joined_at,
          (w.owner_user_id = wm.user_id) AS is_owner,
          (u.password_hash IS NOT NULL) AS is_activated,
          u.status, u.status_reason,
          (SELECT max(s.last_seen_at) FROM fdp_auth_sessions s WHERE s.user_id = wm.user_id) AS last_seen_at,
          (SELECT string_agg(a.company_id, ',') FROM fdp_member_company_access a
             WHERE a.workspace_id = wm.workspace_id AND a.user_id = wm.user_id) AS company_ids,
          (SELECT am.area_id FROM fdp_area_members am JOIN fdp_areas area
             ON area.workspace_id = am.workspace_id AND area.id = am.area_id AND area.status = 'active'
             WHERE am.workspace_id = wm.workspace_id AND am.user_id = wm.user_id AND am.is_primary = 1 LIMIT 1) AS department_id,
          (SELECT area.name FROM fdp_area_members am JOIN fdp_areas area
             ON area.workspace_id = am.workspace_id AND area.id = am.area_id AND area.status = 'active'
             WHERE am.workspace_id = wm.workspace_id AND am.user_id = wm.user_id AND am.is_primary = 1 LIMIT 1) AS department_name
        FROM fdp_workspace_members wm
        JOIN fdp_users u ON u.id = wm.user_id
        JOIN fdp_workspaces w ON w.id = wm.workspace_id
        WHERE wm.workspace_id = ?
        ORDER BY (w.owner_user_id = wm.user_id) DESC, u.name`).bind(workspace.id).all<MemberRow>(),
      d1.prepare(`SELECT GREATEST(s.seat_quantity, p.included_seats)::integer AS seat_limit,
          p.name AS plan_name, p.code AS plan_code, s.status AS subscription_status,
          (SELECT COUNT(*)::integer FROM fdp_workspace_members WHERE workspace_id = ?) AS seats_used
        FROM fdp_workspace_subscriptions s JOIN fdp_saas_plans p ON p.id = s.plan_id
        WHERE s.workspace_id = ?`)
        .bind(workspace.id, workspace.id)
        .first<{ seat_limit: number; plan_name: string; plan_code: string; subscription_status: string; seats_used: number }>(),
      d1.prepare("SELECT id, trade_name, legal_name, is_principal FROM fdp_companies WHERE workspace_id = ? ORDER BY is_principal DESC, trade_name")
        .bind(workspace.id).all<{ id: string; trade_name: string; legal_name: string; is_principal: boolean | number }>(),
      d1.prepare(`SELECT area.id, area.name, area.code,
          COALESCE(jsonb_agg(assignment.module_key ORDER BY assignment.module_key)
            FILTER (WHERE module.key IS NOT NULL), '[]'::jsonb) AS module_keys
        FROM fdp_areas area
        LEFT JOIN fdp_area_module_assignments assignment ON assignment.workspace_id = area.workspace_id AND assignment.area_id = area.id
        LEFT JOIN fdp_modules module ON module.key = assignment.module_key AND module.status = 'active'
        WHERE area.workspace_id = ? AND area.status = 'active'
        GROUP BY area.id, area.name, area.code ORDER BY area.name`)
        .bind(workspace.id).all<{ id: string; name: string; code: string; module_keys: string[] }>(),
    ]);

    const truthy = (value: unknown) => value === true || value === 1 || value === "t" || value === "true";

    return Response.json({
      canManage: hasCapability(workspace, "members.manage"),
      seats: seats
        ? {
          planName: String(seats.plan_name), planCode: String(seats.plan_code),
          subscriptionStatus: String(seats.subscription_status),
          limit: Number(seats.seat_limit), used: Number(seats.seats_used),
        }
        // Sem assinatura o produto não inventa limite: a tela mostra o estado real.
        : { planName: "", planCode: "", subscriptionStatus: "none", limit: 0, used: members.results.length },
      companies: companies.results.map((row) => ({
        id: String(row.id),
        name: String(row.trade_name || row.legal_name),
        isPrincipal: truthy(row.is_principal),
      })),
      departments: departments.results.map((row) => ({
        id: String(row.id), name: String(row.name), code: String(row.code),
        moduleKeys: Array.isArray(row.module_keys) ? row.module_keys.map(String) : [],
      })),
      members: members.results.map((row) => ({
        userId: String(row.user_id),
        email: String(row.email),
        name: String(row.name),
        role: String(row.role),
        joinedAt: String(row.joined_at),
        isOwner: truthy(row.is_owner),
        isActivated: truthy(row.is_activated),
        status: String(row.status ?? "active"),
        statusReason: String(row.status_reason ?? ""),
        lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
        companyIds: String(row.company_ids ?? "").split(",").filter(Boolean),
        departmentId: row.department_id ? String(row.department_id) : null,
        departmentName: String(row.department_name ?? ""),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
