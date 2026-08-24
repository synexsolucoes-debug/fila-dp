import { getScopedD1 } from "@/db";
import { ApiError, apiError } from "@/lib/fila-dp-api";
import { prepareAuditEvent, recordActivity } from "@/lib/fila-dp-db";
import { verifyTangerinoWorkerRequest } from "@/lib/tangerino/worker-auth";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ authorizationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { authorizationId } = await context.params;
    const workspaceId = (request.headers.get("x-vinculato-workspace-id") ?? "").trim().slice(0, 120);
    const body = await request.json() as { expectedCount?: unknown };
    const expectedCount = Number(body.expectedCount);
    if (!workspaceId || !authorizationId || !Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 50) {
      throw ApiError.badRequest("Conclusão inválida.", "ATTACHMENT_COMPLETION_INVALID");
    }
    if (!verifyTangerinoWorkerRequest({
      headers: request.headers, workspaceId, authorizationId, action: "COMPLETE", value: String(expectedCount),
    })) {
      throw new ApiError(401, "WORKER_UNAUTHORIZED", "Worker não autorizado.");
    }

    const d1 = getScopedD1({ workspaceId, userId: null });
    const completed = await d1.prepare(`UPDATE fdp_tangerino_attachment_authorizations
      SET state = 'COMPLETED', expected_count = ?, error_code = '', completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND state = 'RUNNING' AND expires_at > CURRENT_TIMESTAMP
        AND uploaded_count = ?
      RETURNING card_id, uploaded_count`)
      .bind(expectedCount, workspaceId, authorizationId, expectedCount)
      .first<{ card_id: string; uploaded_count: number }>();
    if (!completed) {
      throw new ApiError(409, "ATTACHMENT_COUNT_MISMATCH",
        "A transferência não pode ser concluída porque a conferência dos arquivos não fechou.");
    }

    await d1.batch([
      prepareAuditEvent({
        workspaceId, actorType: "system", actorEmail: "SYSTEM",
        action: "tangerino.attachments.completed", entityType: "card", entityId: String(completed.card_id),
        after: { authorizationId, uploadedCount: Number(completed.uploaded_count) },
      }),
    ]);
    await recordActivity(workspaceId, String(completed.card_id), "SYSTEM", "tangerino.attachments.completed", {
      authorizationId, uploadedCount: Number(completed.uploaded_count),
    });
    return Response.json({ completed: true, uploadedCount: Number(completed.uploaded_count) });
  } catch (error) {
    return apiError(error);
  }
}
