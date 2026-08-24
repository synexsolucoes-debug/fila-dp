import { createHash } from "node:crypto";
import { getScopedD1 } from "@/db";
import { ApiError, apiError } from "@/lib/fila-dp-api";
import { MAX_CARD_ATTACHMENT_SIZE, storeCardAttachment } from "@/lib/card-attachments";
import { verifyTangerinoWorkerRequest } from "@/lib/tangerino/worker-auth";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ authorizationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_CARD_ATTACHMENT_SIZE + 1024 * 1024) {
    return Response.json({ error: "Arquivo acima do limite." }, { status: 413 });
  }
  try {
    const { authorizationId } = await context.params;
    const workspaceId = (request.headers.get("x-vinculato-workspace-id") ?? "").trim().slice(0, 120);
    if (!workspaceId || !authorizationId) throw new ApiError(401, "WORKER_UNAUTHORIZED", "Worker não autorizado.");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) throw ApiError.badRequest("Arquivo obrigatório.", "ATTACHMENT_REQUIRED");
    const bytes = Buffer.from(await file.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    const signatureValue = `${digest}:${file.size}`;
    if (!verifyTangerinoWorkerRequest({
      headers: request.headers, workspaceId, authorizationId, action: "UPLOAD", value: signatureValue,
    })) {
      throw new ApiError(401, "WORKER_UNAUTHORIZED", "Worker não autorizado.");
    }

    const d1 = getScopedD1({ workspaceId, userId: null });
    const authorization = await d1.prepare(`SELECT card_id FROM fdp_tangerino_attachment_authorizations
      WHERE workspace_id = ? AND id = ? AND state = 'RUNNING' AND expires_at > CURRENT_TIMESTAMP`)
      .bind(workspaceId, authorizationId).first<{ card_id: string }>();
    if (!authorization) throw new ApiError(409, "ATTACHMENT_AUTHORIZATION_INACTIVE", "A autorização não está ativa.");

    const stored = await storeCardAttachment({
      d1, workspaceId, cardId: String(authorization.card_id), filename: file.name,
      contentType: file.type, sizeBytes: file.size,
      body: new Blob([bytes], { type: file.type }).stream(), uploadedBy: "Agente Sólides",
      sourceType: "solides", sourceReference: `${authorization.card_id}:${digest}`,
    });
    if (stored.created) {
      await d1.prepare(`UPDATE fdp_tangerino_attachment_authorizations
        SET uploaded_count = uploaded_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ? AND state = 'RUNNING'`)
        .bind(workspaceId, authorizationId).run();
    }
    return Response.json({ attachmentId: stored.attachmentId, created: stored.created });
  } catch (error) {
    return apiError(error);
  }
}
