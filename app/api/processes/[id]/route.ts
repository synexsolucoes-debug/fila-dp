import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { processCriticalities, processPriorities, processSlaUnits, sanitizeIdList, sanitizeProcessTags } from "@/lib/process-management";
import { requireProcessCompanyAccess } from "@/lib/process-access";

type Row = Record<string, unknown>;
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json() as Row;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.manage", "editar processos");
    const current = await d1.prepare("SELECT * FROM fdp_process_definitions WHERE workspace_id=? AND id=?").bind(workspace.id, id).first<Row>();
    if (!current) throw ApiError.notFound("Processo não encontrado.", "PROCESS_NOT_FOUND");
    await requireProcessCompanyAccess(d1, workspace.id, user.id, workspace.role, id, Number(current.is_corporate) === 1);
    const name = cleanText(body.name, 160) || String(current.name); const description = Object.hasOwn(body, "description") ? cleanText(body.description, 4000) : String(current.description ?? "");
    const objective = Object.hasOwn(body, "objective") ? cleanText(body.objective, 4000) : String(current.objective ?? ""); const category = cleanText(body.category, 80) || String(current.category);
    const ownerDepartmentId = Object.hasOwn(body, "ownerDepartmentId") ? cleanText(body.ownerDepartmentId, 120) : String(current.owner_department_id ?? "");
    const ownerUserId = Object.hasOwn(body, "ownerUserId") ? cleanText(body.ownerUserId, 120) : String(current.owner_user_id ?? "");
    if (ownerDepartmentId && !await d1.prepare("SELECT id FROM fdp_areas WHERE workspace_id=? AND id=? AND status='active'").bind(workspace.id, ownerDepartmentId).first()) throw ApiError.badRequest("Área responsável inválida.", "PROCESS_AREA_INVALID");
    if (ownerUserId && !await d1.prepare("SELECT 1 FROM fdp_workspace_members WHERE workspace_id=? AND user_id=?").bind(workspace.id, ownerUserId).first()) throw ApiError.badRequest("Responsável inválido.", "PROCESS_OWNER_INVALID");
    let active = Object.hasOwn(body, "active") ? Boolean(body.active) : String(current.status) !== "inactive";
    const isCorporate = Object.hasOwn(body, "isCorporate") ? Boolean(body.isCorporate) : Number(current.is_corporate) === 1;
    const companyIds = isCorporate ? [] : sanitizeIdList(body.companyIds, 100); const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!isCorporate && !companyIds.length) throw ApiError.badRequest("Selecione ao menos uma empresa para um processo restrito.", "PROCESS_COMPANY_REQUIRED");
    for (const companyId of companyIds) {
      if (!await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id=? AND id=? AND status='active'").bind(workspace.id, companyId).first()) throw ApiError.badRequest("Empresa inválida.", "PROCESS_COMPANY_INVALID");
      if (!access.unrestricted && !access.companyIds.has(companyId)) throw ApiError.forbidden("Você não tem acesso a uma das empresas selecionadas.", "COMPANY_ACCESS_REQUIRED");
    }
    const requestedLifecycle = cleanText(body.lifecycleStatus, 40); let lifecycle = String(current.lifecycle_status || "draft");
    if (requestedLifecycle === "archived") lifecycle = "archived";
    else if (requestedLifecycle === "restore" && lifecycle === "archived") {
      const currentVersion = current.current_version_id
        ? await d1.prepare("SELECT status FROM fdp_process_versions WHERE workspace_id=? AND id=? AND definition_id=?").bind(workspace.id, current.current_version_id, id).first<Row>()
        : null;
      const versionStatus = String(currentVersion?.status || "draft");
      lifecycle = versionStatus === "published" ? "published" : versionStatus === "in_review" ? "in_review" : "draft";
      active = true;
    } else if (!active) lifecycle = "inactive";
    const allowManualStart = Object.hasOwn(body, "allowManualStart") ? Boolean(body.allowManualStart) : Number(current.allow_manual_start) === 1;
    const allowAutomaticStart = Object.hasOwn(body, "allowAutomaticStart") ? Boolean(body.allowAutomaticStart) : Number(current.allow_automatic_start) === 1;
    const requirePublicationApproval = Object.hasOwn(body, "requirePublicationApproval") ? Boolean(body.requirePublicationApproval) : Number(current.require_publication_approval) === 1;
    const globalSlaValue = Object.hasOwn(body, "globalSlaValue") ? Math.max(0, Math.min(525600, Math.trunc(Number(body.globalSlaValue) || 0))) : Number(current.global_sla_value ?? 0);
    const globalSlaUnit = processSlaUnits.includes(String(body.globalSlaUnit) as (typeof processSlaUnits)[number]) ? String(body.globalSlaUnit) : String(current.global_sla_unit || "hours");
    const criticality = processCriticalities.includes(String(body.criticality) as (typeof processCriticalities)[number]) ? String(body.criticality) : String(current.criticality || "medium");
    const defaultPriority = processPriorities.includes(String(body.defaultPriority) as (typeof processPriorities)[number]) ? String(body.defaultPriority) : String(current.default_priority || "normal");
    const tags = Object.hasOwn(body, "tags") ? sanitizeProcessTags(body.tags) : (Array.isArray(current.tags_json) ? current.tags_json : []); const notes = Object.hasOwn(body, "notes") ? cleanText(body.notes, 4000) : String(current.notes ?? "");
    await d1.batch([
      d1.prepare(`UPDATE fdp_process_definitions SET name=?,description=?,objective=?,category=?,status=?,lifecycle_status=?,owner_department_id=?,owner_user_id=?,is_corporate=?,allow_manual_start=?,allow_automatic_start=?,require_publication_approval=?,global_sla_value=?,global_sla_unit=?,criticality=?,default_priority=?,tags_json=?::jsonb,notes=?,archived_at=CASE WHEN ?='archived' THEN COALESCE(archived_at,now()) ELSE NULL END,updated_by=?,updated_at=now() WHERE workspace_id=? AND id=?`)
        .bind(name, description, objective, category, active ? "active" : "inactive", lifecycle, ownerDepartmentId || null, ownerUserId || null, isCorporate ? 1 : 0, allowManualStart ? 1 : 0, allowAutomaticStart ? 1 : 0, requirePublicationApproval ? 1 : 0, globalSlaValue, globalSlaUnit, criticality, defaultPriority, JSON.stringify(tags), notes, lifecycle, user.id, workspace.id, id),
      d1.prepare("DELETE FROM fdp_process_companies WHERE workspace_id=? AND process_id=?").bind(workspace.id, id),
      ...companyIds.map((companyId) => d1.prepare("INSERT INTO fdp_process_companies (workspace_id,process_id,company_id,created_by) VALUES (?,?,?,?)").bind(workspace.id, id, companyId, user.id)),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: lifecycle === "archived" ? "process.archived" : requestedLifecycle === "restore" ? "process.restored" : "process.updated", entityType: "process_definition", entityId: id, before: current, after: { name, description, objective, category, lifecycle, ownerDepartmentId, ownerUserId, isCorporate, companyIds }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ process: { id, name, lifecycleStatus: lifecycle, active } });
  } catch (error) { return apiError(error); }
}
