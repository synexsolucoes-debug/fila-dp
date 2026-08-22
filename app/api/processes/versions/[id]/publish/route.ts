import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { validBpmnXml } from "@/lib/process-management";
import { requireProcessCompanyAccess } from "@/lib/process-access";

/**
 * Publica uma versão de processo.
 *
 * Publicar é o ato que torna a versão executável: a partir daqui ela pode ser
 * instanciada como demanda. A versão publicada anterior é aposentada
 * (`retired`) e as demandas que ela originou continuam presas a ela — quem
 * seguia a v4 termina pela v4 (§11).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "processes.publish", "publicar uma versão de processo");

    const version = await d1.prepare(`SELECT v.*, p.id AS process_id, p.require_publication_approval, p.is_corporate
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

    const status = String(version.status);
    if (!["draft", "in_review"].includes(status)) {
      throw ApiError.badRequest(
        "Somente um rascunho ou versão em revisão pode ser publicada.",
        "PROCESS_VERSION_NOT_PUBLISHABLE",
      );
    }
    if (Number(version.require_publication_approval) === 1 && status !== "in_review") {
      throw ApiError.badRequest("Este processo exige revisão antes da publicação.", "PROCESS_REVIEW_REQUIRED");
    }
    validBpmnXml(version.bpmn_xml);

    const count = await d1.prepare(
      "SELECT COUNT(*) AS total FROM fdp_process_step_configs WHERE workspace_id = ? AND process_version_id = ?",
    ).bind(workspace.id, id).first<{ total: string | number }>();
    if (Number(count?.total ?? 0) === 0) {
      throw ApiError.badRequest(
        "Configure ao menos uma etapa do BPMN antes de publicar.",
        "PROCESS_STEP_CONFIG_REQUIRED",
      );
    }

    await d1.batch([
      d1.prepare(`UPDATE fdp_process_versions SET status = 'retired'
        WHERE workspace_id = ? AND definition_id = ? AND status = 'published' AND id <> ?`)
        .bind(workspace.id, version.definition_id, id),
      d1.prepare(`UPDATE fdp_process_versions
          SET status = 'published', published_at = now(), published_by = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ? AND status IN ('draft', 'in_review')`)
        .bind(user.id, user.id, workspace.id, id),
      d1.prepare(`UPDATE fdp_process_definitions
          SET lifecycle_status = 'published', status = 'active', current_version_id = ?, updated_by = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(id, user.id, workspace.id, version.definition_id),
      prepareAuditEvent({
        workspaceId: workspace.id,
        actorUserId: user.id,
        actorEmail: auth.user.email,
        action: "process.version_published",
        entityType: "process_version",
        entityId: id,
        before: { status },
        after: {
          status: "published",
          processId: version.definition_id,
          versionMajor: version.version_major,
          versionMinor: version.version_minor,
        },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({
      version: {
        id,
        processId: version.definition_id,
        status: "published",
        versionMajor: Number(version.version_major),
        versionMinor: Number(version.version_minor),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
