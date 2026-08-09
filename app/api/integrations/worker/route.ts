import { timingSafeEqual } from "node:crypto";
import { getD1 } from "@/db";
import { apiError, text } from "@/lib/fila-dp-api";
import { processNextIntegrationJob } from "@/lib/integration-engine";
import { setTenantContext } from "@/lib/tenant-context";

function matchesSecret(received: string, expected: string) {
  if (received.length < 32 || expected.length < 32) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  try {
    const expected = process.env.FDP_INTEGRATION_WORKER_SECRET ?? "";
    const received = request.headers.get("x-fila-dp-worker-secret") ?? "";
    if (!matchesSecret(received, expected)) return Response.json({ error: "Executor não autorizado." }, { status: 401 });
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > 4096) return Response.json({ error: "Payload excede 4 KB." }, { status: 413 });
    const body = await request.json() as Record<string, unknown>;
    const workspaceId = text(body.workspaceId, 120);
    if (!workspaceId) return Response.json({ error: "workspaceId obrigatório." }, { status: 400 });
    setTenantContext({ workspaceId, userId: null });
    const d1 = getD1();
    const workspace = await d1.prepare("SELECT id FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first();
    if (!workspace) return Response.json({ error: "Workspace não encontrado." }, { status: 404 });
    const result = await processNextIntegrationJob(d1, workspaceId);
    return Response.json({ processed: Boolean(result), result });
  } catch (error) { return apiError(error); }
}
