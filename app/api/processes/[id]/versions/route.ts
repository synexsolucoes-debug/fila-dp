import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { defaultBpmnXml } from "@/lib/process-management";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params; const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user); requireNamedCapability(workspace, "processes.manage", "criar uma nova versão de processo");
    const process = await d1.prepare("SELECT id,name,code,lifecycle_status FROM fdp_process_definitions WHERE workspace_id=? AND id=?").bind(workspace.id, id).first<{id:string;name:string;code:string;lifecycle_status:string}>();
    if (!process || process.lifecycle_status === "archived") throw ApiError.notFound("Processo ativo não encontrado.", "PROCESS_NOT_FOUND");
    const latest = await d1.prepare("SELECT * FROM fdp_process_versions WHERE workspace_id=? AND definition_id=? ORDER BY version_major DESC,version_minor DESC,version DESC LIMIT 1").bind(workspace.id, id).first<Record<string, unknown>>();
    if (latest && ["draft", "in_review"].includes(String(latest.status))) throw new ApiError(409, "PROCESS_DRAFT_EXISTS", "Este processo já possui uma versão em rascunho ou revisão.");
    const sequential = Number(latest?.version ?? 0)+1; const bumpMajor = body.bump === "major"; const major = latest ? (bumpMajor ? Number(latest.version_major ?? 1)+1 : Number(latest.version_major ?? 1)) : 1; const minor = latest ? (bumpMajor ? 0 : Number(latest.version_minor ?? 0)+1) : 0;
    const versionId=crypto.randomUUID(); const changeSummary=cleanText(body.changeSummary,1000)||`Nova versão v${major}.${minor}.`; const bpmnXml=String(latest?.bpmn_xml||defaultBpmnXml(process.name,process.code)); const svgPreview=String(latest?.svg_preview||"");
    const configuration = latest?.configuration_json && typeof latest.configuration_json === "object" ? latest.configuration_json : {schemaVersion:1,automationReady:true};
    const statements = [d1.prepare(`INSERT INTO fdp_process_versions (id,workspace_id,definition_id,version,version_major,version_minor,status,configuration_json,bpmn_xml,svg_preview,revision,change_summary,created_by,updated_by) VALUES (?,?,?,?,?,?,'draft',?::jsonb,?,?,0,?,?,?)`).bind(versionId,workspace.id,id,sequential,major,minor,JSON.stringify(configuration),bpmnXml,svgPreview,changeSummary,user.id,user.id)];
    if (latest?.id) statements.push(d1.prepare(`INSERT INTO fdp_process_step_configs (id,workspace_id,process_version_id,bpmn_element_id,step_type,department_id,responsible_user_id,responsibility_mode,sla_value,sla_unit,sla_business_days,cutoff_time,escalation_json,create_demand,demand_type,requester_department_id,responsible_department_id,demand_priority,demand_sla_value,demand_sla_unit,checklist_id,checklist_json,form_id,required_documents_json,optional_documents_json,evidence_required,requires_approval,approver_user_id,approver_department_id,approval_count,approval_mode,subprocess_process_id,settings_json)
      SELECT gen_random_uuid()::text,workspace_id,?,bpmn_element_id,step_type,department_id,responsible_user_id,responsibility_mode,sla_value,sla_unit,sla_business_days,cutoff_time,escalation_json,create_demand,demand_type,requester_department_id,responsible_department_id,demand_priority,demand_sla_value,demand_sla_unit,checklist_id,checklist_json,form_id,required_documents_json,optional_documents_json,evidence_required,requires_approval,approver_user_id,approver_department_id,approval_count,approval_mode,subprocess_process_id,settings_json FROM fdp_process_step_configs WHERE workspace_id=? AND process_version_id=?`).bind(versionId,workspace.id,latest.id));
    statements.push(d1.prepare("UPDATE fdp_process_definitions SET current_version_id=?,lifecycle_status='draft',status='active',updated_by=?,updated_at=now() WHERE workspace_id=? AND id=?").bind(versionId,user.id,workspace.id,id), prepareAuditEvent({workspaceId:workspace.id,actorUserId:user.id,actorEmail:auth.user.email,action:"process.version_created",entityType:"process_version",entityId:versionId,after:{processId:id,versionMajor:major,versionMinor:minor,status:"draft",sourceVersionId:latest?.id??null},requestId:request.headers.get("x-fila-dp-request-id")}));
    await d1.batch(statements); return Response.json({version:{id:versionId,processId:id,version:sequential,versionMajor:major,versionMinor:minor,status:"draft",revision:0,bpmnXml,svgPreview,changeSummary}},{status:201});
  } catch(error){return apiError(error);}
}
