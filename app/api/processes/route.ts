import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { cleanProcessCode, defaultBpmnXml, parseJsonArray, processCriticalities, processPriorities, processSlaUnits, sanitizeIdList, sanitizeProcessTags } from "@/lib/process-management";

type Row = Record<string, unknown>;
type WorkspaceD1 = Awaited<ReturnType<typeof getWorkspaceContext>>["d1"];
const bool = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";
const text = (value: unknown) => value == null ? "" : String(value);

function companiesOf(row: Row) {
  return parseJsonArray(row.companies_json).map((item) => {
    const record = item && typeof item === "object" ? item as Row : {};
    return { id: text(record.id), name: text(record.name) };
  }).filter((item) => item.id);
}

function processOf(row: Row) {
  const companies = companiesOf(row);
  const currentVersion = row.current_version_id_effective ? {
    id: text(row.current_version_id_effective), version: Number(row.current_version ?? 1), versionMajor: Number(row.version_major ?? 1),
    versionMinor: Number(row.version_minor ?? 0), status: text(row.version_status || "draft"), revision: Number(row.version_revision ?? 0),
    bpmnXml: text(row.bpmn_xml), svgPreview: text(row.svg_preview), updatedAt: text(row.version_updated_at), publishedAt: text(row.published_at),
  } : null;
  return {
    id: text(row.id), code: text(row.code), name: text(row.name), description: text(row.description), objective: text(row.objective), category: text(row.category),
    ownerDepartmentId: text(row.owner_department_id), ownerDepartmentName: text(row.owner_department_name), ownerUserId: text(row.owner_user_id), ownerUserName: text(row.owner_user_name),
    lifecycleStatus: text(row.lifecycle_status || "draft"), active: text(row.status) !== "inactive", currentVersionId: text(row.current_version_id_effective),
    isCorporate: bool(row.is_corporate), allowManualStart: bool(row.allow_manual_start), allowAutomaticStart: bool(row.allow_automatic_start), requirePublicationApproval: bool(row.require_publication_approval),
    globalSlaValue: Number(row.global_sla_value ?? 0), globalSlaUnit: text(row.global_sla_unit || "hours"), criticality: text(row.criticality || "medium"), defaultPriority: text(row.default_priority || "normal"),
    tags: parseJsonArray(row.tags_json).map(String), notes: text(row.notes), stepCount: Number(row.step_count ?? 0), companies,
    createdBy: text(row.created_by), updatedBy: text(row.updated_by), updatedByName: text(row.updated_by_name), createdAt: text(row.created_at), updatedAt: text(row.updated_at), archivedAt: text(row.archived_at), currentVersion,
  };
}

async function requireArea(d1: WorkspaceD1, workspaceId: string, areaId: string) {
  if (!areaId) return;
  if (!await d1.prepare("SELECT id FROM fdp_areas WHERE workspace_id = ? AND id = ? AND status = 'active'").bind(workspaceId, areaId).first()) throw ApiError.badRequest("A área responsável não pertence a este workspace ou está inativa.", "PROCESS_AREA_INVALID");
}
async function requireMember(d1: WorkspaceD1, workspaceId: string, userId: string) {
  if (!userId) return;
  if (!await d1.prepare("SELECT 1 FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId).first()) throw ApiError.badRequest("O responsável informado não pertence a este workspace.", "PROCESS_OWNER_INVALID");
}

export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.read", "consultar a Biblioteca de Processos");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const [rows, versionRows] = await Promise.all([
      d1.prepare(`SELECT p.*, a.name AS owner_department_name, owner.name AS owner_user_name, updater.name AS updated_by_name,
          v.id AS current_version_id_effective, v.version AS current_version, v.version_major, v.version_minor, v.status AS version_status,
          v.revision AS version_revision, v.bpmn_xml, v.svg_preview, v.updated_at AS version_updated_at, v.published_at,
          (SELECT COUNT(*) FROM fdp_process_step_configs sc WHERE sc.workspace_id = p.workspace_id AND sc.process_version_id = v.id) AS step_count,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', COALESCE(NULLIF(c.trade_name, ''), c.legal_name)) ORDER BY COALESCE(NULLIF(c.trade_name, ''), c.legal_name))
            FROM fdp_process_companies pc JOIN fdp_companies c ON c.workspace_id = pc.workspace_id AND c.id = pc.company_id
            WHERE pc.workspace_id = p.workspace_id AND pc.process_id = p.id), '[]'::jsonb) AS companies_json
        FROM fdp_process_definitions p
        LEFT JOIN fdp_areas a ON a.workspace_id = p.workspace_id AND a.id = p.owner_department_id
        LEFT JOIN fdp_users owner ON owner.id = p.owner_user_id LEFT JOIN fdp_users updater ON updater.id = p.updated_by
        LEFT JOIN LATERAL (SELECT pv.* FROM fdp_process_versions pv WHERE pv.workspace_id = p.workspace_id AND pv.definition_id = p.id
          ORDER BY CASE WHEN pv.id = p.current_version_id THEN 0 ELSE 1 END, pv.version_major DESC, pv.version_minor DESC, pv.version DESC LIMIT 1) v ON true
        WHERE p.workspace_id = ? ORDER BY p.updated_at DESC, p.name`).bind(workspace.id).all<Row>(),
      d1.prepare(`SELECT v.*, p.name AS process_name, creator.name AS created_by_name FROM fdp_process_versions v
        JOIN fdp_process_definitions p ON p.workspace_id = v.workspace_id AND p.id = v.definition_id
        LEFT JOIN fdp_users creator ON creator.id = v.created_by WHERE v.workspace_id = ?
        ORDER BY v.created_at DESC, v.version_major DESC, v.version_minor DESC`).bind(workspace.id).all<Row>(),
    ]);
    const processes = rows.results.map(processOf).filter((process) => process.isCorporate || access.unrestricted || process.companies.some((company) => access.companyIds.has(company.id)));
    const visibleIds = new Set(processes.map((process) => process.id));
    const versions = versionRows.results.filter((row) => visibleIds.has(text(row.definition_id))).map((row) => ({
      id: text(row.id), processId: text(row.definition_id), processName: text(row.process_name), version: Number(row.version), versionMajor: Number(row.version_major ?? 1), versionMinor: Number(row.version_minor ?? 0),
      status: text(row.status), revision: Number(row.revision ?? 0), changeSummary: text(row.change_summary), createdBy: text(row.created_by), createdByName: text(row.created_by_name),
      createdAt: text(row.created_at), updatedAt: text(row.updated_at), publishedBy: text(row.published_by), publishedAt: text(row.published_at),
    }));
    return Response.json({ processes, versions, currentUserId: user.id, permissions: { view: true, manage: hasCapability(workspace, "processes.manage"), publish: hasCapability(workspace, "processes.publish") } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Row;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.manage", "criar processos");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const code = cleanProcessCode(body.code); const name = cleanText(body.name, 160);
    if (!code || !name) throw ApiError.badRequest("Código e nome são obrigatórios.", "PROCESS_REQUIRED_FIELDS");
    if (await d1.prepare("SELECT id FROM fdp_process_definitions WHERE workspace_id = ? AND code = ?").bind(workspace.id, code).first()) throw new ApiError(409, "PROCESS_CODE_CONFLICT", "Já existe um processo com este código.");
    const ownerDepartmentId = cleanText(body.ownerDepartmentId, 120); const ownerUserId = cleanText(body.ownerUserId, 120) || user.id;
    await requireArea(d1, workspace.id, ownerDepartmentId); await requireMember(d1, workspace.id, ownerUserId);
    const isCorporate = body.isCorporate !== false; const companyIds = isCorporate ? [] : sanitizeIdList(body.companyIds, 100);
    if (!isCorporate && companyIds.length === 0) throw ApiError.badRequest("Selecione ao menos uma empresa para um processo restrito.", "PROCESS_COMPANY_REQUIRED");
    for (const companyId of companyIds) {
      if (!await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND id = ? AND status = 'active'").bind(workspace.id, companyId).first()) throw ApiError.badRequest("Uma das empresas selecionadas não pertence a este workspace ou está inativa.", "PROCESS_COMPANY_INVALID");
      if (!access.unrestricted && !access.companyIds.has(companyId)) throw ApiError.forbidden("Você não tem acesso a uma das empresas selecionadas.", "COMPANY_ACCESS_REQUIRED");
    }
    const category = cleanText(body.category, 80) || "general"; const description = cleanText(body.description, 4000); const objective = cleanText(body.objective, 4000); const tags = sanitizeProcessTags(body.tags);
    const active = body.active !== false; const allowManualStart = body.allowManualStart !== false; const allowAutomaticStart = Boolean(body.allowAutomaticStart); const requirePublicationApproval = Boolean(body.requirePublicationApproval);
    const globalSlaValue = Math.max(0, Math.min(525600, Math.trunc(Number(body.globalSlaValue) || 0)));
    const globalSlaUnit = processSlaUnits.includes(String(body.globalSlaUnit) as (typeof processSlaUnits)[number]) ? String(body.globalSlaUnit) : "hours";
    const criticality = processCriticalities.includes(String(body.criticality) as (typeof processCriticalities)[number]) ? String(body.criticality) : "medium";
    const defaultPriority = processPriorities.includes(String(body.defaultPriority) as (typeof processPriorities)[number]) ? String(body.defaultPriority) : "normal";
    const notes = cleanText(body.notes, 4000); const processId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const bpmnXml = defaultBpmnXml(name, code || processId);
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_process_definitions (id,workspace_id,code,name,description,objective,category,status,lifecycle_status,owner_department_id,owner_user_id,is_corporate,allow_manual_start,allow_automatic_start,require_publication_approval,global_sla_value,global_sla_unit,criticality,default_priority,tags_json,notes,created_by,updated_by)
        VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?)`).bind(processId, workspace.id, code, name, description, objective, category, active ? "active" : "inactive", ownerDepartmentId || null, ownerUserId, isCorporate ? 1 : 0, allowManualStart ? 1 : 0, allowAutomaticStart ? 1 : 0, requirePublicationApproval ? 1 : 0, globalSlaValue, globalSlaUnit, criticality, defaultPriority, JSON.stringify(tags), notes, user.id, user.id),
      d1.prepare(`INSERT INTO fdp_process_versions (id,workspace_id,definition_id,version,version_major,version_minor,status,configuration_json,bpmn_xml,svg_preview,revision,change_summary,created_by,updated_by)
        VALUES (?,?,?,1,1,0,'draft','{\"schemaVersion\":1,\"automationReady\":true}'::jsonb,?,'',0,'Versão inicial do processo.',?,?)`).bind(versionId, workspace.id, processId, bpmnXml, user.id, user.id),
      ...companyIds.map((companyId) => d1.prepare("INSERT INTO fdp_process_companies (workspace_id,process_id,company_id,created_by) VALUES (?,?,?,?)").bind(workspace.id, processId, companyId, user.id)),
      d1.prepare("UPDATE fdp_process_definitions SET current_version_id=?, updated_at=now() WHERE workspace_id=? AND id=?").bind(versionId, workspace.id, processId),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "process.created", entityType: "process_definition", entityId: processId, after: { code, name, category, ownerDepartmentId, ownerUserId, isCorporate, companyIds }, metadata: { versionId, version: "1.0" }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ process: { id: processId, code, name, lifecycleStatus: active ? "draft" : "inactive", currentVersionId: versionId }, version: { id: versionId, processId, version: 1, versionMajor: 1, versionMinor: 0, status: "draft", revision: 0, bpmnXml, svgPreview: "" } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
