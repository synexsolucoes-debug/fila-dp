import { timingSafeEqual } from "node:crypto";
import { getScopedD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { processNextIntegrationJob } from "@/lib/integration-engine";
import { log } from "@/lib/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Disparo agendado do executor de integrações.
 *
 * O que motivou isto: `/api/integrations/worker` só processa um job e exige que
 * quem chama informe o workspace. Nada chamava esse endpoint, então sincronizar
 * enfileirava trabalho que nunca saía da fila — o sintoma era "a sincronização
 * não anda", sem erro em lugar nenhum.
 *
 * Este endpoint existe para a Vercel Cron, que só faz GET e não envia cabeçalho
 * próprio nem corpo: ela manda `Authorization: Bearer <CRON_SECRET>`. Por isso a
 * autenticação aqui é por Bearer, e não pelo cabeçalho do executor.
 */
const MINIMUM_SECRET_LENGTH = 32;
/** Sobra para responder antes do limite da função, em vez de ser cortado no meio de um job. */
const TIME_BUDGET_MS = 45_000;
/** Teto por workspace: um tenant com fila grande não pode consumir a janela inteira. */
const MAX_JOBS_PER_WORKSPACE = 25;

function matchesSecret(received: string, expected: string) {
  if (received.length < MINIMUM_SECRET_LENGTH || expected.length < MINIMUM_SECRET_LENGTH) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Aceita o segredo da Vercel Cron e também o do executor, para que quem já
 * configurou `FDP_INTEGRATION_WORKER_SECRET` não precise de uma segunda variável
 * com o mesmo papel. Um segredo curto nunca é aceito, mesmo que confira.
 */
function authorized(request: Request) {
  const received = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/iu, "").trim();
  if (!received) return false;
  return [process.env.CRON_SECRET, process.env.FDP_INTEGRATION_WORKER_SECRET]
    .some((expected) => typeof expected === "string" && matchesSecret(received, expected.trim()));
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Execução agendada não autorizada." }, { status: 401 });
  try {
    const deadline = Date.now() + TIME_BUDGET_MS;
    // `fdp_workspaces` é a raiz do tenant e não tem RLS; a fila tem. Por isso a
    // lista sai daqui e cada workspace é processado com o tenant preso à conexão,
    // em vez de depender do contexto assíncrono sobreviver ao laço.
    const roots = getScopedD1({ workspaceId: "", userId: null });
    const workspaces = await roots.prepare("SELECT id FROM fdp_workspaces WHERE status = 'active' ORDER BY created_at").all<{ id: string }>();

    let processed = 0;
    let failed = 0;
    const touched: string[] = [];
    for (const workspace of workspaces.results) {
      if (Date.now() >= deadline) break;
      const scoped = getScopedD1({ workspaceId: workspace.id, userId: null });
      let handled = 0;
      while (handled < MAX_JOBS_PER_WORKSPACE && Date.now() < deadline) {
        // Um job com defeito não pode parar a varredura dos demais workspaces:
        // o próprio executor já registra a falha, agenda a retentativa e devolve.
        const result = await processNextIntegrationJob(scoped, workspace.id);
        if (!result) break;
        handled += 1;
        if (result.status === "succeeded" || result.status === "partial") processed += 1; else failed += 1;
      }
      if (handled) touched.push(workspace.id);
    }

    log("info", "integrations.cron_swept", {}, { workspaces: workspaces.results.length, touched: touched.length, processed, failed });
    return Response.json({ swept: workspaces.results.length, touched: touched.length, processed, failed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
