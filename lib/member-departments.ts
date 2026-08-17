import type { getD1 } from "../db";
import { ApiError } from "./api-errors";
import { cleanText } from "./clean-text";

type Database = ReturnType<typeof getD1>;

export type MemberDepartmentAccess = {
  department: { id: string; name: string; code: string };
  departmentModuleKeys: string[];
  selectedModuleKeys: string[];
};

/**
 * Valida a lotação e a liberação inicial antes de criar ou alterar o usuário.
 * O departamento é o universo máximo; a seleção individual só pode reduzir
 * esse conjunto, nunca puxar um módulo de outra área.
 */
export async function resolveMemberDepartmentAccess(
  d1: Database,
  workspaceId: string,
  rawDepartmentId: unknown,
  rawModuleKeys: unknown,
): Promise<MemberDepartmentAccess> {
  const departmentId = cleanText(rawDepartmentId, 120);
  if (!departmentId) {
    throw ApiError.badRequest("Selecione o departamento principal do usuário.", "MEMBER_DEPARTMENT_REQUIRED");
  }

  const department = await d1.prepare(`SELECT id, name, code
      FROM fdp_areas WHERE workspace_id = ? AND id = ? AND status = 'active'`)
    .bind(workspaceId, departmentId)
    .first<{ id: string; name: string; code: string }>();
  if (!department) {
    throw ApiError.badRequest("O departamento selecionado não existe ou não está ativo.", "MEMBER_DEPARTMENT_INVALID");
  }

  const assigned = await d1.prepare(`SELECT assignment.module_key
      FROM fdp_area_module_assignments assignment
      JOIN fdp_modules module ON module.key = assignment.module_key AND module.status = 'active'
      WHERE assignment.workspace_id = ? AND assignment.area_id = ?
      ORDER BY module.position, assignment.module_key`)
    .bind(workspaceId, departmentId)
    .all<{ module_key: string }>();
  const departmentModuleKeys = assigned.results.map((row) => String(row.module_key));
  if (departmentModuleKeys.length === 0) {
    throw new ApiError(409, "DEPARTMENT_WITHOUT_MODULES",
      "Este departamento ainda não possui módulos. Configure os módulos do departamento antes de criar ou mover usuários.");
  }

  const selectedModuleKeys = Array.isArray(rawModuleKeys)
    ? [...new Set(rawModuleKeys.map((key) => cleanText(key, 80)).filter(Boolean))]
    : [...departmentModuleKeys];
  if (selectedModuleKeys.length === 0) {
    throw ApiError.badRequest("Libere pelo menos um módulo do departamento para o usuário.", "MEMBER_MODULE_REQUIRED");
  }
  const departmentSet = new Set(departmentModuleKeys);
  if (selectedModuleKeys.some((key) => !departmentSet.has(key))) {
    throw ApiError.badRequest("Um dos módulos selecionados não pertence ao departamento informado.", "MEMBER_MODULE_OUTSIDE_DEPARTMENT");
  }

  return {
    department: { id: String(department.id), name: String(department.name), code: String(department.code) },
    departmentModuleKeys,
    selectedModuleKeys,
  };
}

/**
 * Um único lote troca a lotação principal e grava uma decisão explícita para
 * cada módulo do departamento. Assim a pessoa não consegue entrar no intervalo
 * entre "criada" e "permissões configuradas".
 */
export function prepareMemberDepartmentAccess(
  d1: Database,
  input: {
    workspaceId: string;
    userId: string;
    actorUserId: string;
    workspaceRole: string;
    access: MemberDepartmentAccess;
  },
): D1PreparedStatement[] {
  const selected = new Set(input.access.selectedModuleKeys);
  const areaRole = input.workspaceRole === "admin" ? "manager" : "member";
  return [
    d1.prepare("UPDATE fdp_area_members SET is_primary = 0, updated_at = now() WHERE workspace_id = ? AND user_id = ?")
      .bind(input.workspaceId, input.userId),
    d1.prepare(`INSERT INTO fdp_area_members
        (id, workspace_id, area_id, user_id, role, is_primary, created_by)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT (workspace_id, area_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, is_primary = 1, updated_at = now()`)
      .bind(crypto.randomUUID(), input.workspaceId, input.access.department.id, input.userId, areaRole, input.actorUserId),
    d1.prepare("DELETE FROM fdp_member_module_grants WHERE workspace_id = ? AND user_id = ?")
      .bind(input.workspaceId, input.userId),
    ...input.access.departmentModuleKeys.map((moduleKey) => d1.prepare(`INSERT INTO fdp_member_module_grants
        (workspace_id, user_id, module_key, granted, reason, granted_by)
        VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(input.workspaceId, input.userId, moduleKey, selected.has(moduleKey),
        "Acesso definido no cadastro do usuário.", input.actorUserId)),
  ];
}
