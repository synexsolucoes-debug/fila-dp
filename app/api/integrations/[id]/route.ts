import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertConnectorTargets, buildConnectorConfig } from "@/lib/connector-config";

/* As regras de configuração saíram daqui para `lib/connector-config.ts`: o
   console da plataforma passou a gravar os mesmos campos, e duas cópias das
   mesmas validações divergem — a que ficasse para trás aceitaria um endpoint
   que a outra recusa. Esta rota continua sendo a porta do workspace; o que ela
   decide é quem entra e o que fica auditado, não o que é aceito. */

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.manage");
    const current = await d1.prepare("SELECT id, channel, display_name, status, config_json FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
    const body = await request.json() as Record<string, unknown>;
    const channel = String(current.channel);
    if (channel === "sankhya_browser") {
      throw ApiError.forbidden("A configuração Sankhya é gerenciada exclusivamente pela Plataforma Global.", "SANKHYA_PLATFORM_ADMIN_REQUIRED");
    }
    const { displayName, status, config, configuredFields } = buildConnectorConfig({
      channel, currentDisplayName: String(current.display_name), body,
    });
    await assertConnectorTargets(d1, workspace.id, config);
    await d1.batch([
      d1.prepare("UPDATE fdp_integrations SET display_name = ?, status = ?, config_json = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(displayName, status, JSON.stringify(config), workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "integration.configured", entityType: "integration", entityId: id,
        before: { displayName: current.display_name, status: current.status }, after: { displayName, status, configuredFields }, requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ id, channel, displayName, status, configuredFields });
  } catch (error) { return apiError(error); }
}
