import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { parseJsonArray, safeSvgPreview, sanitizeProcessStepConfigs, validBpmnXml } from "@/lib/process-management";
import { parseConditionList, parseTransitionConditions } from "@/lib/process-conditions";
import { parseDocumentProof } from "@/lib/process-documents";

type Row = Record<string, unknown>;
type WorkspaceD1 = Awaited<ReturnType<typeof getWorkspaceContext>>["d1"];

const text = (value: unknown) => (value == null ? "" : String(value));
const bool = (value: unknown) => value === true || value === 1 || value === "1";

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stepOf(row: Row) {
  const settings = jsonObject(row.settings_json);
  return {
    id: text(row.id),
    bpmnElementId: text(row.bpmn_element_id),
    stepType: text(row.step_type),
    departmentId: text(row.department_id),
    responsibleUserId: text(row.responsible_user_id),
    responsibilityMode: text(row.responsibility_mode),
    slaValue: Number(row.sla_value ?? 0),
    slaUnit: text(row.sla_unit || "hours"),
    slaBusinessDays: bool(row.sla_business_days),
    cutoffTime: text(row.cutoff_time),
    escalation: jsonObject(row.escalation_json),
    createDemand: bool(row.create_demand),
    demandType: text(row.demand_type),
    requesterDepartmentId: text(row.requester_department_id),
    responsibleDepartmentId: text(row.responsible_department_id),
    demandPriority: text(row.demand_priority || "normal"),
    demandSlaValue: Number(row.demand_sla_value ?? 0),
    demandSlaUnit: text(row.demand_sla_unit || "hours"),
    checklistId: text(row.checklist_id),
    checklistItems: parseJsonArray(row.checklist_json).map(String),
    formId: text(row.form_id),
    requiredDocuments: parseJsonArray(row.required_documents_json).map(String),
    optionalDocuments: parseJsonArray(row.optional_documents_json).map(String),
    evidenceRequired: bool(row.evidence_required),
    requiresApproval: bool(row.requires_approval),
    approverUserId: text(row.approver_user_id),
    approverDepartmentId: text(row.approver_department_id),
    approvalCount: Number(row.approval_count ?? 1),
    approvalMode: text(row.approval_mode || "sequential"),
    subprocessProcessId: text(row.subprocess_process_id),
    settings: {
      name: text(settings.name),
      description: text(settings.description),
      instructions: text(settings.instructions),
      internalCode: text(settings.internalCode),
      dynamicAssignee: text(settings.dynamicAssignee),
      notificationTemplate: text(settings.notificationTemplate),
      entryRules: parseConditionList(settings.entryRules),
      exitRules: parseConditionList(settings.exitRules),
      transitions: parseTransitionConditions(settings.transitions),
      blockingIntegrations: parseJsonArray(settings.blockingIntegrations).map(String),
      documentProof: parseDocumentProof(settings.documentProof),
      tasks: parseJsonArray(settings.tasks),
    },
  };
}

async function loadVersion(d1: WorkspaceD1, workspaceId: string, id: string) {
  return d1.prepare(`SELECT v.*, p.name AS process_name, p.code AS process_code,
      p.require_publication_approval, p.is_corporate
      FROM fdp_process_versions v
      JOIN fdp_process_definitions p ON p.workspace_id = v.workspace_id AND p.id = v.definition_id
     WHERE v.workspace_id = ? AND v.id = ?`)
    .bind(workspaceId, id)
    .first() as Promise<Row | null>;
}

async function requireScope(
  d1: WorkspaceD1,
  workspaceId: string,
  version: Row,
  access: { unrestricted: boolean; companyIds: Set<string> },
) {
  if (access.unrestricted || bool(version.is_corporate)) return;
  const rows = await d1.prepare("SELECT company_id FROM fdp_process_companies WHERE workspace_id = ? AND process_id = ?")
    .bind(workspaceId, version.definition_id)
    .all<{ company_id: string }>();
  if (!rows.results.some((row) => access.companyIds.has(String(row.company_id)))) {
    throw ApiError.forbidden("Você não tem acesso às empresas relacionadas a este processo.", "COMPANY_ACCESS_REQUIRED");
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.read", "consultar uma versão de processo");

    const version = await loadVersion(d1, workspace.id, id);
    if (!version) throw ApiError.notFound("Versão não encontrada.", "PROCESS_VERSION_NOT_FOUND");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    await requireScope(d1, workspace.id, version, access);

    const steps = await d1.prepare(
      "SELECT * FROM fdp_process_step_configs WHERE workspace_id = ? AND process_version_id = ? ORDER BY bpmn_element_id",
    ).bind(workspace.id, id).all<Row>();

    return Response.json({
      version: {
        id: text(version.id),
        processId: text(version.definition_id),
        processName: text(version.process_name),
        processCode: text(version.process_code),
        version: Number(version.version),
        versionMajor: Number(version.version_major),
        versionMinor: Number(version.version_minor),
        status: text(version.status),
        revision: Number(version.revision),
        bpmnXml: text(version.bpmn_xml),
        svgPreview: text(version.svg_preview),
        configuration: jsonObject(version.configuration_json),
        changeSummary: text(version.change_summary),
        createdAt: text(version.created_at),
        updatedAt: text(version.updated_at),
        publishedAt: text(version.published_at),
        requirePublicationApproval: bool(version.require_publication_approval),
      },
      stepConfigs: steps.results.map(stepOf),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Row;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.manage", "salvar um rascunho de processo");

    const version = await loadVersion(d1, workspace.id, id);
    if (!version) throw ApiError.notFound("Versão não encontrada.", "PROCESS_VERSION_NOT_FOUND");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    await requireScope(d1, workspace.id, version, access);

    if (version.status !== "draft") {
      throw ApiError.badRequest(
        "Somente versões em rascunho podem ser alteradas. Crie uma nova versão para editar um processo publicado.",
        "PROCESS_VERSION_IMMUTABLE",
      );
    }

    const expectedRevision = Math.max(0, Math.trunc(Number(body.revision) || 0));
    const bpmnXml = validBpmnXml(body.bpmnXml);
    const svgPreview = safeSvgPreview(body.svgPreview);
    const stepConfigs = sanitizeProcessStepConfigs(body.stepConfigs);
    const configuration = {
      schemaVersion: 1,
      automationReady: true,
      stepCount: stepConfigs.length,
      lastSavedAt: new Date().toISOString(),
    };

    try {
      await d1.batch([
        d1.prepare("SELECT fdp_save_process_version_draft(?,?,?,?,?,?::jsonb,?::jsonb,?)")
          .bind(
            workspace.id, id, expectedRevision, bpmnXml, svgPreview,
            JSON.stringify(configuration), JSON.stringify(stepConfigs), user.id,
          ),
        prepareAuditEvent({
          workspaceId: workspace.id,
          actorUserId: user.id,
          actorEmail: auth.user.email,
          action: "process.version_saved",
          entityType: "process_version",
          entityId: id,
          before: { revision: expectedRevision },
          after: { revision: expectedRevision + 1, stepCount: stepConfigs.length },
          requestId: request.headers.get("x-fila-dp-request-id"),
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/revision conflict|40001|serialization/i.test(message)) {
        throw new ApiError(409, "PROCESS_VERSION_CONFLICT",
          "Esta versão foi alterada em outra aba ou sessão. Recarregue antes de continuar para não sobrescrever mudanças.");
      }
      throw error;
    }

    return Response.json({
      version: { id, revision: expectedRevision + 1, status: "draft", updatedAt: new Date().toISOString() },
      saved: true,
    });
  } catch (error) {
    return apiError(error);
  }
}
