import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { validBpmnXml } from "@/lib/process-management";
import { requireProcessCompanyAccess } from "@/lib/process-access";

/** Envia um rascunho de versão para revisão. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.manage", "enviar uma versão de processo para revisão");

    const version = await d1.prepare(`SELECT v.*, p.id AS process_id, p.is_corporate
        FROM fdp_process_versions v
        JOIN fdp_process_definitions p ON p.workspace_id = v.workspace_id AND p.id = v.definition_id
       WHERE v.workspace_id = ? AND v.id = ?`)
      .bind(workspace.id, id)
      .first<Record<string, unknown>>();
    if (!version) throw ApiError.notFound("Versão não encontrada.", "PROCESS_VERSION_NOT_FOUND");

    await requireProcessCompanyAccess(
      d1, workspace.id, user.id, workspace.role,
      String(version.process_id), Number(version.is_corporate) === 1,
    );
    if (version.status !== "draft") {
      throw ApiError.badRequest("Somente um rascunho pode ser enviado para revisão.", "PROCESS_VERSION_NOT_DRAFT");
    }
    validBpmnXml(version.bpmn_xml);

    await d1.batch([
      d1.prepare(`UPDATE fdp_process_versions
          SET status = 'in_review', updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND status = 'draft'`)
        .bind(user.id, workspace.id, id),
      d1.prepare(`UPDATE fdp_process_definitions
          SET lifecycle_status = 'in_review', current_version_id = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(id, user.id, workspace.id, version.process_id),
      prepareAuditEvent({
        workspaceId: workspace.id,
        actorUserId: user.id,
        actorEmail: auth.user.email,
        action: "process.version_review_requested",
        entityType: "process_version",
        entityId: id,
        before: { status: "draft" },
        after: { status: "in_review", processId: version.process_id },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ version: { id, status: "in_review" } });
  } catch (error) {
    return apiError(error);
  }
}
