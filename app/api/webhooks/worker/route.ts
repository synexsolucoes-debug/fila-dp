import { timingSafeEqual } from "node:crypto";
import { getD1 } from "@/db";
import { apiError, text } from "@/lib/fila-dp-api";
import { log, requestIdFrom } from "@/lib/observability";
import { publishPendingDomainEvents } from "@/lib/outbox";
import { processNextWebhookDelivery } from "@/lib/webhooks";
import { setTenantContext } from "@/lib/tenant-context";

function matchesSecret(received: string, expected: string) {
  if (received.length < 32 || expected.length < 32) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Executor das entregas de webhook.
 *
 * Publica os eventos pendentes do outbox e drena um lote de entregas fora da
 * requisição do usuário. O I/O com o endpoint externo nunca acontece dentro de
 * uma transação de negócio.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const expected = process.env.FDP_INTEGRATION_WORKER_SECRET ?? "";
    const received = request.headers.get("x-fila-dp-worker-secret") ?? "";
    if (!matchesSecret(received, expected)) return Response.json({ error: "Executor não autorizado." }, { status: 401 });
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > 4096) return Response.json({ error: "Payload excede 4 KB." }, { status: 413 });

    const body = await request.json() as Record<string, unknown>;
    const workspaceId = text(body.workspaceId, 120);
    if (!workspaceId) return Response.json({ error: "workspaceId obrigatório." }, { status: 400 });
    const batchSize = Math.min(Math.max(Number(body.batchSize) || 10, 1), 50);

    setTenantContext({ workspaceId, userId: null });
    const d1 = getD1();
    const workspace = await d1.prepare("SELECT id FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first();
    if (!workspace) return Response.json({ error: "Workspace não encontrado." }, { status: 404 });

    const published = await publishPendingDomainEvents(d1, workspaceId);
    const processed = [];
    for (let index = 0; index < batchSize; index += 1) {
      const result = await processNextWebhookDelivery(d1, workspaceId);
      if (!result) break;
      processed.push(result);
    }

    log("info", "webhook.worker_run", { requestId, workspaceId }, {
      publishedEvents: published.published,
      createdDeliveries: published.deliveries,
      processedDeliveries: processed.length,
      deadLettered: processed.filter((item) => item.status === "dead_letter").length,
    });

    return Response.json({ published, processed });
  } catch (error) { return apiError(error); }
}
