import { getScopedD1 } from "@/db";
import { ApiError, apiError } from "@/lib/fila-dp-api";
import { prepareSheetAfterTransfer } from "@/lib/admission-sheet-service";
import { log } from "@/lib/observability";
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

    /* O PDF chegou: prepara a ficha aqui mesmo, sem esperar clique.
     *
     * Era neste ponto que o fluxo parava. O agente entrava no Tangerino,
     * baixava os documentos e anexava à demanda — e a transcrição continuava
     * manual porque ninguém sabia que precisava abrir a aba e clicar em "Ler a
     * ficha". Ligar as duas pontas aqui é o que transforma a transferência em
     * trabalho pronto em vez de arquivo guardado.
     *
     * A falha da leitura NÃO derruba a conclusão: o arquivo chegou, e isso é um
     * fato independente de conseguirmos interpretá-lo. Recusar a conclusão
     * faria o worker tentar transferir tudo de novo por causa de um PDF que ele
     * já entregou corretamente. O estado fica gravado na ficha, e a tela diz o
     * que aconteceu. */
    let sheet: { state: string; readable: number } | null = null;
    try {
      const prepared = await prepareSheetAfterTransfer(d1, { workspaceId, cardId: String(completed.card_id) });
      if (prepared.preparation) {
        sheet = { state: prepared.preparation.state, readable: prepared.preparation.readable };
        await recordActivity(workspaceId, String(completed.card_id), "SYSTEM", "admission.sheet.built", {
          trigger: "transfer", state: prepared.preparation.state, readable: prepared.preparation.readable,
        });
      }
    } catch (cause) {
      log("warn", "admission.sheet_after_transfer_failed", { workspaceId }, {
        cardId: String(completed.card_id),
        errorName: cause instanceof Error ? cause.name : "UnknownError",
      });
    }

    return Response.json({ completed: true, uploadedCount: Number(completed.uploaded_count), sheet });
  } catch (error) {
    return apiError(error);
  }
}
