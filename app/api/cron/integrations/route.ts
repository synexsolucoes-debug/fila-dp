import { timingSafeEqual } from "node:crypto";
import { getScopedD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { processNextIntegrationJob, queueIntegrationRun } from "@/lib/integration-engine";
import { log } from "@/lib/observability";
import { nextSankhyaRunAt, parseSankhyaConfig } from "@/lib/sankhya/config";
import { queueSankhyaRun } from "@/lib/sankhya/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Disparo agendado da consulta da Sólides DP e do executor de integrações.
 *
 * O que motivou isto: `/api/integrations/worker` só processa um job e exige que
 * quem chama informe o workspace. Nada chamava esse endpoint, então sincronizar
 * enfileirava trabalho que nunca saía da fila — o sintoma era "a sincronização
 * não anda", sem erro em lugar nenhum. A varredura agora também cria uma
 * execução para cada conector Tangerino pronto, de modo que novas fichas não
 * dependam do botão de sincronização.
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
/** Mesma cadência do workflow; a chave torna duas chamadas no mesmo intervalo idempotentes. */
const SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;

function scheduledRunKey(now = Date.now()) {
  const intervalStart = Math.floor(now / SCHEDULE_INTERVAL_MS) * SCHEDULE_INTERVAL_MS;
  return `scheduled:${new Date(intervalStart).toISOString()}`;
}

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
  return [process.env.CRON_SECRET, process.env.FDP_INTEGRATION_WORKER_SECRET, process.env.GITHUB_INTEGRATIONS_CRON_SECRET]
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
    let scheduled = 0;
    let scheduleFailed = 0;
    let sankhyaScheduled = 0;
    const touched: string[] = [];
    const idempotencyKey = scheduledRunKey();
    for (const workspace of workspaces.results) {
      if (Date.now() >= deadline) break;
      const scoped = getScopedD1({ workspaceId: workspace.id, userId: null });

      // O cron também inicia a consulta: antes ele apenas drenava jobs criados
      // manualmente. Só entra o conector Tangerino conectado, com mapeamento de
      // admissões ativo e sem outra execução pendente, evitando acúmulo de fila.
      const integrations = await scoped.prepare(`SELECT integration.id, mapping.id AS mapping_id
        FROM fdp_integrations integration
        JOIN LATERAL (
          SELECT candidate.id FROM fdp_integration_mappings candidate
          WHERE candidate.workspace_id = integration.workspace_id AND candidate.integration_id = integration.id
            AND candidate.status = 'active' AND candidate.resource_type = 'admissions'
            AND candidate.direction IN ('inbound', 'bidirectional')
          ORDER BY candidate.published_at DESC NULLS LAST, candidate.created_at DESC LIMIT 1
        ) mapping ON TRUE
        WHERE integration.workspace_id = ? AND integration.channel = 'tangerino' AND integration.status = 'connected'
          AND NOT EXISTS (
            SELECT 1 FROM fdp_integration_jobs pending
            WHERE pending.workspace_id = integration.workspace_id AND pending.integration_id = integration.id
              AND pending.status IN ('queued', 'leased')
          ) ORDER BY integration.created_at`).bind(workspace.id).all<{ id: string; mapping_id: string }>();
      for (const integration of integrations.results) {
        if (Date.now() >= deadline) break;
        try {
          await queueIntegrationRun(scoped, {
            workspaceId: workspace.id,
            integrationId: integration.id,
            mappingId: integration.mapping_id,
            triggerType: "scheduled",
            requestedBy: null,
            idempotencyKey,
          });
          scheduled += 1;
        } catch (error) {
          scheduleFailed += 1;
          log("warn", "integrations.cron_schedule_failed", { workspaceId: workspace.id, connectorId: integration.id }, {
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorCode: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code).slice(0, 60) : undefined,
          });
        }
      }

      // O cron somente enfileira o RPA. A sessão Playwright nunca é aberta dentro
      // da função Vercel; o worker containerizado a consumirá com contexto isolado.
      const sankhyaDue = await scoped.prepare(`SELECT integration.id, integration.config_json, integration.next_sync_at
        FROM fdp_integrations integration
        JOIN fdp_workspace_module_grants grant ON grant.workspace_id = integration.workspace_id
          AND grant.module_key = 'sankhya_browser' AND grant.granted = 1 AND (grant.expires_at IS NULL OR grant.expires_at > CURRENT_TIMESTAMP)
        WHERE integration.workspace_id = ? AND integration.channel = 'sankhya_browser' AND integration.status = 'connected'
          AND integration.schedule_enabled = 1 AND integration.next_sync_at <= CURRENT_TIMESTAMP
          AND NOT EXISTS (SELECT 1 FROM fdp_integration_jobs pending WHERE pending.workspace_id = integration.workspace_id
            AND pending.integration_id = integration.id AND pending.status IN ('queued', 'leased'))`)
        .bind(workspace.id).all<{ id: string; config_json: string; next_sync_at: string }>();
      for (const integration of sankhyaDue.results) {
        try {
          await queueSankhyaRun(scoped, { workspaceId: workspace.id, integrationId: integration.id, triggerType: "scheduled", requestedBy: null,
            idempotencyKey: `sankhya:scheduled:${integration.next_sync_at}` });
          const next = nextSankhyaRunAt(parseSankhyaConfig(integration.config_json));
          await scoped.prepare("UPDATE fdp_integrations SET next_sync_at = ?::timestamptz, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
            .bind(next, workspace.id, integration.id).run();
          sankhyaScheduled += 1;
        } catch (error) {
          scheduleFailed += 1;
          log("warn", "sankhya.schedule_failed", { workspaceId: workspace.id, connectorId: integration.id }, {
            errorCode: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code).slice(0, 60) : undefined,
          });
        }
      }

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

    log("info", "integrations.cron_swept", {}, { workspaces: workspaces.results.length, touched: touched.length, scheduled, sankhyaScheduled, scheduleFailed, processed, failed });
    return Response.json({ swept: workspaces.results.length, touched: touched.length, scheduled, sankhyaScheduled, scheduleFailed, processed, failed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
