import { timingSafeEqual } from "node:crypto";
import { getScopedD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import {
  asAgentQueueConflict, decideAgentSchedule, listSchedulableAgents, prepareNextRun,
} from "@/lib/agent-scheduler";
import { processNextIntegrationJob, queueIntegrationRun } from "@/lib/integration-engine";
import { sweepOverdueTasks } from "@/lib/process-automations";
import { log } from "@/lib/observability";
import { nextSankhyaRunAt, parseSankhyaConfig } from "@/lib/sankhya/config";
import { queueSankhyaRun } from "@/lib/sankhya/queue";
import { prepareSweepCandidates, prepareSweepConsultation, toSweepCandidate } from "@/lib/tangerino/sweep";
import { wakeSankhyaWorker } from "@/lib/sankhya/actions-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Disparo agendado da consulta da Sólides DP e do executor de integrações.
 *
 * O que motivou isto: `/api/integrations/worker` só processa um job e exige que
 * quem chama informe o workspace. Nada chamava esse endpoint, então sincronizar
 * enfileirava trabalho que nunca saía da fila — o sintoma era "a sincronização
 * não anda", sem erro em lugar nenhum. A varredura passou a também **criar**
 * execução, de modo que novas fichas não dependam do botão de sincronização.
 *
 * Quem entra em cada ciclo é decidido pela cadência declarada no conector (§29)
 * — antes era uma regra escrita aqui dentro, que valia só para o Tangerino e
 * não podia ser mudada sem deploy. Este é também o runner da execução
 * automática dos agentes (§28): nenhum agente roda dentro da requisição de
 * quem abriu a tela.
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
    // Consultas de admissão enfileiradas pela varredura do Agente Tangerino.
    // Não confundir com `swept` na resposta, que conta workspaces varridos.
    let admissionsQueued = 0;
    let scheduleFailed = 0;
    let sankhyaScheduled = 0;
    let sankhyaPending = 0;
    let workspacesFailed = 0;
    const touched: string[] = [];
    /* Recusas que valem ser ditas: agente sem credencial ou sem mapeamento não
       roda, e quem configurou precisa saber disso sem abrir log de servidor
       (§56). "Manual", "ainda não venceu" e "já enfileirado" não entram: são o
       funcionamento normal, e listá-los afogaria o que importa. */
    const skipped: string[] = [];
    for (const workspace of workspaces.results) {
      if (Date.now() >= deadline) break;
      const scoped = getScopedD1({ workspaceId: workspace.id, userId: null });

      // Isolamento por tenant. Sem este `try`, qualquer erro nas consultas abaixo
      // aborta a varredura inteira e nenhum workspace seguinte é drenado — foi o
      // que aconteceu com o apelido `grant`: um erro de sintaxe em uma consulta
      // deixou a fila de todos os clientes parada, sem sinal de qual era o
      // problema. Um tenant com defeito agora custa esse tenant, e o restante
      // segue; a contagem `workspacesFailed` é o que denuncia a falha.
      try {
        // O cron também inicia a consulta: antes ele apenas drenava jobs criados
        // manualmente. A regra de quem entra deixou de ser "o Tangerino, sempre"
        // e passou a ser a cadência declarada em cada conector (§29): o motivo
        // de cada recusa fica nomeado, e um agente pausado, sem credencial, sem
        // mapeamento publicado ou fora do expediente nem chega a gastar vaga da
        // varredura (§87).
        /* Tarefa vencida avisa quem responde (§27).
           Antes das integrações de propósito: é barato — duas consultas
           indexadas — e um workspace com fila grande não pode consumir a janela
           inteira e deixar o aviso de prazo para o ciclo seguinte. A falha aqui
           não derruba a varredura do tenant: o `catch` externo já isola, e o
           aviso perdido volta no próximo ciclo, porque a tarefa continua
           vencida e a chave de idempotência continua inédita. */
        await sweepOverdueTasks(scoped, workspace.id).catch(() => undefined);

        const agents = await listSchedulableAgents(scoped, workspace.id);
        for (const decision of decideAgentSchedule(agents, new Date())) {
          if (Date.now() >= deadline) break;
          if (!decision.due) {
            if (decision.reason !== "manual_only" && decision.reason !== "not_due"
              && decision.reason !== "schedule_disabled" && decision.reason !== "already_queued") {
              skipped.push(`${decision.agent.channel}:${decision.reason}`);
            }
            continue;
          }
          try {
            if (decision.agent.channel === "tangerino_browser") {
              /* O Agente Tangerino não usa a fila de jobs: ele enfileira
                 consultas de admissão, uma por colaborador, na fila própria que
                 o worker de navegador drena. Mandá-lo por `queueIntegrationRun`
                 criaria um job que nenhum runner sabe executar — nasceria
                 condenado e só apareceria na carta morta.

                 O que ele compartilha com os demais é a **cadência**: quando
                 executar, com que espera depois de falhar, e quando parar de
                 insistir. Isso é decidido acima, igual para todos. */
              const candidatos = await prepareSweepCandidates(scoped, workspace.id).all<Record<string, unknown>>();
              for (const linha of candidatos.results) {
                await prepareSweepConsultation(scoped, {
                  workspaceId: workspace.id,
                  integrationId: decision.agent.integrationId,
                  candidate: toSweepCandidate(linha),
                }).run();
              }
              admissionsQueued += candidatos.results.length;
            } else {
              await queueIntegrationRun(scoped, {
                workspaceId: workspace.id,
                integrationId: decision.agent.integrationId,
                triggerType: "scheduled",
                requestedBy: null,
                idempotencyKey: decision.idempotencyKey,
              });
            }
            // O próximo horário é gravado ao enfileirar, e não ao concluir: uma
            // execução que trava não pode deixar o conector sem horário previsto
            // e, com isso, fora da varredura para sempre.
            await prepareNextRun(scoped, {
              workspaceId: workspace.id,
              integrationId: decision.agent.integrationId,
              cadence: decision.agent.cadence,
              timeZone: decision.agent.timeZone,
              from: new Date(),
            }).run();
            scheduled += 1;
          } catch (error) {
            // Colisão com o índice de execução ativa não é falha: significa que
            // outro runner já enfileirou este agente neste ciclo.
            if (asAgentQueueConflict(error)) continue;
            scheduleFailed += 1;
            log("warn", "integrations.cron_schedule_failed", { workspaceId: workspace.id, connectorId: decision.agent.integrationId }, {
              errorName: error instanceof Error ? error.name : "UnknownError",
              errorCode: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code).slice(0, 60) : undefined,
            });
          }
        }

        // O cron somente enfileira o RPA. A sessão Playwright nunca é aberta dentro
        // da função Vercel; o worker containerizado a consumirá com contexto isolado.
        // `grant` é palavra reservada do PostgreSQL e não serve de apelido: a
        // consulta inteira falhava com `syntax error at or near "grant"`, e como o
        // erro estourava no meio da varredura, nenhum job de nenhum workspace
        // chegava a ser drenado. O apelido é `module_grant` por isso.
        const sankhyaDue = await scoped.prepare(`SELECT integration.id, integration.config_json, integration.next_sync_at
          FROM fdp_integrations integration
          JOIN fdp_workspace_module_grants module_grant ON module_grant.workspace_id = integration.workspace_id
            AND module_grant.module_key = 'sankhya_browser' AND module_grant.granted = 1
            AND (module_grant.expires_at IS NULL OR module_grant.expires_at > CURRENT_TIMESTAMP)
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

        const pendingSankhya = await scoped.prepare(`SELECT COUNT(*)::integer AS pending
          FROM fdp_integration_jobs job
          JOIN fdp_integrations integration ON integration.workspace_id = job.workspace_id AND integration.id = job.integration_id
          WHERE job.workspace_id = ? AND integration.channel = 'sankhya_browser'
            AND job.status IN ('queued', 'leased') AND job.available_at <= CURRENT_TIMESTAMP
            AND (job.status = 'queued' OR job.lease_expires_at < CURRENT_TIMESTAMP)`)
          .bind(workspace.id).first<{ pending: number }>();
        sankhyaPending += Number(pendingSankhya?.pending ?? 0);

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
      } catch (error) {
        workspacesFailed += 1;
        log("error", "integrations.cron_workspace_failed", { workspaceId: workspace.id }, {
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
          errorCode: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code).slice(0, 60) : undefined,
        });
      }
    }

    const workerDispatch = sankhyaPending ? await wakeSankhyaWorker({ route: "/api/cron/integrations" }) : null;
    log("info", "integrations.cron_swept", {}, { workspaces: workspaces.results.length, touched: touched.length, scheduled, admissionsQueued, sankhyaScheduled, sankhyaPending, scheduleFailed, processed, failed, workspacesFailed,
      skipped: skipped.length, workerDispatched: workerDispatch?.status === "dispatched" });
    // A varredura responde 500 quando algum tenant falhou. O workflow do GitHub
    // trata != 200 como falha, então o alerta chega em vez de a fila parar em
    // silêncio; os contadores continuam no corpo para dizer o que passou.
    return Response.json({ swept: workspaces.results.length, touched: touched.length, scheduled, admissionsQueued, sankhyaScheduled, sankhyaPending, workerDispatch: workerDispatch?.status ?? "not_needed", scheduleFailed, processed, failed, workspacesFailed,
      // Até vinte recusas nomeadas: o suficiente para diagnosticar sem transformar
      // a resposta do cron em despejo da base.
      skipped: skipped.slice(0, 20) },
      { status: workspacesFailed ? 500 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
