import { getAttachmentsBucket, getD1, getPlatformScopedD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";

type Context = { params: Promise<{ id: string; diagnosticId: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const { id, diagnosticId } = await params;
    const workspaceId = cleanText(new URL(request.url).searchParams.get("workspaceId"), 120);
    if (!workspaceId) throw ApiError.badRequest("Informe o workspace do diagnóstico.", "WORKSPACE_REQUIRED");
    return await withPlatformContext(platform, async () => {
      const exists = await getD1().prepare("SELECT 1 FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first();
      if (!exists) throw ApiError.notFound("Workspace não encontrado.", "WORKSPACE_NOT_FOUND");
      const scoped = getPlatformScopedD1({ workspaceId, userId: platform.userId });
      const diagnostic = await scoped.prepare(`SELECT object_key FROM fdp_integration_diagnostics
        WHERE id = ? AND workspace_id = ? AND integration_id = ? AND kind = 'screenshot' AND expires_at > CURRENT_TIMESTAMP`)
        .bind(diagnosticId, workspaceId, id).first<{ object_key: string }>();
      if (!diagnostic) throw ApiError.notFound("Diagnóstico expirado ou não encontrado.", "DIAGNOSTIC_NOT_FOUND");
      const object = await getAttachmentsBucket().get(diagnostic.object_key);
      if (!object) throw ApiError.notFound("Arquivo de diagnóstico não encontrado.", "DIAGNOSTIC_OBJECT_NOT_FOUND");
      const headers = new Headers({
        "Content-Type": "image/png",
        "Content-Length": String(object.size),
        "Content-Disposition": `inline; filename="sankhya-diagnostic-${encodeURIComponent(diagnosticId)}.png"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      return new Response(object.body, { headers });
    });
  } catch (error) { return apiError(error); }
}
