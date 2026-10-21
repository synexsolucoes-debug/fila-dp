import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";

/** Configuração do DP Operacional: dono das rotinas do grupo e destinatários do relatório mensal. */
export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar a configuração do DP");
    const row = await d1.prepare("SELECT tenant_task_owner_user_id, report_recipients FROM fdp_dp_settings WHERE workspace_id = ?")
      .bind(workspace.id).first<{ tenant_task_owner_user_id: string | null; report_recipients: string }>();
    return Response.json({ tenantTaskOwnerUserId: row?.tenant_task_owner_user_id ?? null, reportRecipients: row?.report_recipients ?? "" });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "alterar a configuração do DP");
    const owner = cleanText(body.tenantTaskOwnerUserId, 120) || null;
    if (owner) {
      const member = await d1.prepare("SELECT 1 FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('admin', 'member')")
        .bind(workspace.id, owner).first();
      if (!member) throw ApiError.badRequest("O responsável precisa ser membro ativo do grupo.", "DP_SETTINGS_OWNER_INVALID");
    }
    const recipients = cleanText(body.reportRecipients, 2000).split(/[,;\s]+/u).map((item) => item.trim().toLowerCase()).filter(Boolean);
    const invalid = recipients.find((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email));
    if (invalid) throw ApiError.badRequest(`E-mail inválido: ${invalid}`, "DP_SETTINGS_RECIPIENT_INVALID");
    const value = [...new Set(recipients)].slice(0, 30).join(", ");
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_dp_settings (workspace_id, tenant_task_owner_user_id, report_recipients, updated_by, updated_at)
        VALUES (?, ?, ?, ?, now())
        ON CONFLICT (workspace_id) DO UPDATE SET tenant_task_owner_user_id = EXCLUDED.tenant_task_owner_user_id,
          report_recipients = EXCLUDED.report_recipients, updated_by = EXCLUDED.updated_by, updated_at = now()`)
        .bind(workspace.id, owner, value, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "dp_settings.updated", entityType: "dp_settings", entityId: workspace.id,
        after: { tenantTaskOwnerUserId: owner, reportRecipientsCount: recipients.length },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ tenantTaskOwnerUserId: owner, reportRecipients: value });
  } catch (error) { return apiError(error); }
}
