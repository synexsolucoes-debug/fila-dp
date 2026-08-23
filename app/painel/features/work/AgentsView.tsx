"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Bot, CircleSlash, Cable, History, Pause, Play, RefreshCw, RotateCcw, Timer,
} from "lucide-react";
import { ConfirmDialog, EmptyState, ErrorBanner, LoadingState, PanelHeader } from "../shared";
import {
  formatDateTime, formatDuration, normalizeAgentLog, normalizeAgentRun,
  normalizeAgentsPayload, requestJson,
} from "./work.api";
import type { AgentLogLine, AgentRun, AgentsPayload, AgentStatus } from "./work.types";
import styles from "./work.module.css";

/**
 * Central de Agentes (§20 a §26).
 *
 * Agente aqui não é um chatbot: é **executor controlado** de coleta,
 * classificação e proposta (§73). Não há avatar, não há personalidade e não há
 * prompt editável — o que existe é o que um operador precisa para responder três
 * perguntas: está rodando? o que ele fez? posso parar?
 *
 * ## O interruptor é um só
 *
 * Pausar altera `fdp_integrations.status`, que é o mesmo estado que o webhook, a
 * varredura agendada e o motor de propostas já respeitam. Não existe um segundo
 * lugar onde a automação continue rodando depois de pausada — que é como se
 * descobre, no pior momento, que o agente "parado" seguia trabalhando.
 *
 * ## Erro que diz o que fazer (§56)
 *
 * A tela nunca mostra `RUN_FAILED`. Ela mostra o que aconteceu, qual foi o
 * impacto e o que destrava — porque quem lê isso precisa decidir se espera, se
 * reprocessa ou se chama alguém.
 */

type Confirmation = { agent: AgentStatus; kind: "run" | "pause" | "resume" } | null;

/** Os estados em que a pessoa ainda está montando o agente, e o roteiro ajuda. */
const SETUP_STATES = new Set(["not_configured", "credential_pending", "test_pending", "ready"]);

/** A cor do estado. Cinza é o padrão: nem tudo que não é verde é alarme. */
function agentStateTone(state: string): "critical" | "warning" | "positive" | undefined {
  if (state === "error") return "critical";
  if (state === "degraded" || state === "paused") return "warning";
  if (state === "active") return "positive";
  return undefined;
}

export function AgentsView({ initialRunId = "" }: { initialRunId?: string }) {
  const [payload, setPayload] = useState<AgentsPayload | null>(null);
  const [expanded, setExpanded] = useState("");
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runsCursor, setRunsCursor] = useState("");
  const [logRunId, setLogRunId] = useState(initialRunId);
  const [logs, setLogs] = useState<AgentLogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await requestJson<Record<string, unknown>>("/api/agents");
      setPayload(normalizeAgentsPayload(data));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os agentes.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const loadRuns = useCallback(async (agentKey: string, cursor = "") => {
    setBusy(agentKey);
    try {
      const search = new URLSearchParams();
      if (cursor) search.set("cursor", cursor);
      const data = await requestJson<{ runs?: Record<string, unknown>[]; nextCursor?: string }>(
        `/api/agents/${encodeURIComponent(agentKey)}/logs?${search}`,
      );
      const next = (data.runs ?? []).map(normalizeAgentRun);
      setRuns((current) => (cursor ? [...current, ...next] : next));
      setRunsCursor(String(data.nextCursor ?? ""));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o histórico.");
    } finally { setBusy(""); }
  }, []);

  const loadLogs = useCallback(async (agentKey: string, runId: string) => {
    setLogRunId(runId);
    try {
      const data = await requestJson<{ lines?: Record<string, unknown>[] }>(
        `/api/agents/${encodeURIComponent(agentKey)}/logs?execucao=${encodeURIComponent(runId)}`,
      );
      setLogs((data.lines ?? []).map(normalizeAgentLog));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o log da execução.");
    }
  }, []);

  const toggleExpanded = useCallback(async (agent: AgentStatus) => {
    if (expanded === agent.key) { setExpanded(""); setRuns([]); setLogs([]); return; }
    setExpanded(agent.key);
    setLogs([]);
    await loadRuns(agent.key);
  }, [expanded, loadRuns]);

  const setEnabled = useCallback(async (agent: AgentStatus, enabled: boolean) => {
    setBusy(agent.key);
    try {
      await requestJson("/api/agents", { method: "PATCH", body: JSON.stringify({ agentKey: agent.key, enabled }) });
      setToast(enabled
        ? `${agent.displayName} reativado. Ele volta a rodar na próxima varredura.`
        : `${agent.displayName} pausado. Nenhuma leitura nova é feita até alguém reativá-lo.`);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível alterar o agente.");
    } finally { setBusy(""); }
  }, [load]);

  const setCadence = useCallback(async (agent: AgentStatus, cadence: string) => {
    setBusy(agent.key);
    try {
      await requestJson("/api/agents", { method: "PATCH", body: JSON.stringify({ agentKey: agent.key, cadence }) });
      setToast("Cadência atualizada. O próximo horário já foi recalculado.");
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível alterar a cadência.");
    } finally { setBusy(""); }
  }, [load]);

  const runNow = useCallback(async (agent: AgentStatus) => {
    setBusy(agent.key);
    try {
      const data = await requestJson<{ detail?: string }>(`/api/agents/${encodeURIComponent(agent.key)}/run`, {
        method: "POST", body: JSON.stringify({ confirm: true }),
      });
      setToast(data.detail || "Execução enfileirada.");
      await load(true);
      if (expanded === agent.key) await loadRuns(agent.key);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível enfileirar a execução.");
    } finally { setBusy(""); }
  }, [expanded, load, loadRuns]);

  const reprocess = useCallback(async (agent: AgentStatus, run: AgentRun) => {
    setBusy(agent.key);
    try {
      const data = await requestJson<{ detail?: string }>(`/api/agents/${encodeURIComponent(agent.key)}/reprocess`, {
        method: "POST", body: JSON.stringify({ runId: run.id }),
      });
      setToast(data.detail || "Execução devolvida à fila.");
      await loadRuns(agent.key);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível reprocessar.");
    } finally { setBusy(""); }
  }, [load, loadRuns]);

  if (loading && !payload) return <LoadingState title="Consultando os agentes…" />;

  const agents = payload?.agents ?? [];
  const permissions = payload?.permissions;

  return <section className={styles.workspace}>
    <PanelHeader
      eyebrow="CENTRAL DE AGENTES"
      title="Automação sob controle"
      description="Cada agente lê um sistema de origem e propõe. Nenhum deles escreve no domínio sozinho: o que eles produzem passa pelo motor determinístico e, quando não há certeza, pela triagem."
      action={<button type="button" className={styles.secondaryButton} onClick={() => void load(true)}>
        <RefreshCw aria-hidden="true" />Atualizar
      </button>}
    />

    {error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : null}
    {toast ? <p className={styles.agentDetail} role="status">{toast}</p> : null}

    {payload ? <p className={styles.agentDetail}>
      <strong>Política de automação do grupo:</strong> {payload.automation.label}
    </p> : null}

    {agents.length === 0
      ? <EmptyState
        icon={Cable}
        title="Nenhum agente disponível neste grupo"
        text="O Vinculato trabalha com três automações: Agente Teams, Agente Tangerino e Agente Sankhya. Se nenhuma aparece aqui, o grupo ainda não foi provisionado."
      />
      : <div className={styles.agentGrid}>
        {agents.map((agent) => <article key={agent.key} className={styles.agentCard}>
          <header>
            {agent.kind === "agent" ? <Bot aria-hidden="true" /> : <Cable aria-hidden="true" />}
            <h3>{agent.displayName}</h3>
            {/* O estado vem primeiro porque é a pergunta que a pessoa traz:
                "em que ponto isto está?". A saúde responde outra coisa —
                "como vem indo" — e só faz sentido depois que existe algo
                rodando (§10). */}
            <span className={styles.badge} data-tone={agentStateTone(agent.state.key)}>
              {agent.state.label}
            </span>
            {agent.kind === "channel"
              ? <span className={styles.badge}>Recebe avisos — não entra em sistema nenhum</span>
              : null}
          </header>

          <p className={styles.agentDetail}>{agent.summary}</p>
          <p className={styles.agentDetail}>{agent.state.detail}</p>

          {/* O caminho até o agente trabalhar, na ordem (§11, §12, §13). Some
              quando ele já está pronto: passo a passo de setup em cima de um
              agente ativo é ruído. */}
          {SETUP_STATES.has(agent.state.key) && agent.steps.length ? <ol className={styles.itemMeta}>
            {agent.steps.map((step, index) => <li key={step}>{index + 1}. {step}</li>)}
          </ol> : null}

          {agent.lastError ? <div className={styles.errorDetail}>
            <strong>Última falha</strong>
            <span>{agent.lastError}</span>
            <span>
              {agent.schedule.consecutiveFailures > 0
                ? `${agent.schedule.consecutiveFailures} falha(s) seguida(s). A próxima tentativa é adiada a cada uma delas para não insistir em um sistema fora do ar.`
                : "Nenhuma demanda foi alterada por esta falha."}
            </span>
          </div> : null}

          <div className={styles.metrics}>
            <Metric label="Execuções (30d)" value={String(agent.runs.total)} />
            <Metric label="Falharam" value={String(agent.runs.failed)} />
            <Metric label="Itens lidos" value={String(agent.runs.received)} />
            <Metric label="Processados" value={String(agent.runs.processed)} />
            <Metric label="Ignorados" value={String(agent.runs.skipped)} />
            <Metric label="Em triagem" value={String(agent.proposals.pendingTriage)} />
            <Metric label="Eventos" value={String(agent.events.received)} />
            <Metric label="Reentregas" value={String(agent.events.deduplicated)} />
            <Metric label="Duração média" value={formatDuration(agent.runs.averageDurationMs)} />
            {agent.queue.deadLetter > 0 ? <Metric label="Sem seguir sozinhas" value={String(agent.queue.deadLetter)} /> : null}
          </div>

          <p className={styles.agentDetail}>
            Última execução {formatDateTime(agent.runs.lastAt)} · última bem-sucedida {formatDateTime(agent.runs.lastSuccessAt)}
            {agent.schedule.enabled ? ` · próxima prevista ${formatDateTime(agent.schedule.nextRunAt)} (${agent.schedule.timeZone})` : " · sem execução automática"}
          </p>

          <div className={styles.agentActions}>
            {/* Cadência só para quem tem o que executar periodicamente. O
                Agente Teams recebe avisos e o Agente Tangerino consulta a
                admissão de um colaborador por vez, a partir da ficha dele:
                oferecer "a cada 30 minutos" para eles seria agendar o nada. */}
            {permissions?.manage && agent.supportsSchedule ? <label>
              <Timer aria-hidden="true" />
              <span>Frequência</span>
              <select value={agent.schedule.cadence} disabled={busy === agent.key}
                aria-label={`Frequência de ${agent.displayName}`}
                onChange={(event) => void setCadence(agent, event.target.value)}>
                {(payload?.cadences ?? []).map((cadence) => <option key={cadence.key} value={cadence.key}>{cadence.label}</option>)}
              </select>
            </label> : null}

            {/* §25: o botão só existe habilitado quando há o que executar e o
                acesso já foi provado. `canRunNow` é decidido no servidor, a
                partir do mesmo estado que a tela mostra — a alternativa era a
                tela adivinhar e oferecer o clique que o servidor recusa. */}
            {permissions?.execute && agent.supportsSchedule ? <button type="button" className={styles.secondaryButton}
              disabled={busy === agent.key || !agent.canRunNow}
              title={agent.canRunNow ? undefined : agent.state.detail}
              onClick={() => setConfirmation({ agent, kind: "run" })}>
              <Play aria-hidden="true" />Executar agora
            </button> : null}

            {permissions?.manage ? <button type="button" className={styles.secondaryButton}
              disabled={busy === agent.key}
              onClick={() => setConfirmation({ agent, kind: agent.enabled ? "pause" : "resume" })}>
              {agent.enabled ? <><Pause aria-hidden="true" />Pausar</> : <><Play aria-hidden="true" />Reativar</>}
            </button> : null}

            {permissions?.viewLogs ? <button type="button" className={styles.ghostButton}
              aria-expanded={expanded === agent.key}
              onClick={() => void toggleExpanded(agent)}>
              <History aria-hidden="true" />{expanded === agent.key ? "Ocultar histórico" : "Ver histórico"}
            </button> : null}
          </div>

          {expanded === agent.key ? <div>
            {runs.length === 0
              ? <EmptyState icon={CircleSlash} size="compact"
                title="Este agente ainda não foi executado"
                text="Assim que ele rodar, cada execução aparece aqui com o que entrou, o que foi ignorado e o que falhou." />
              : <>
                <div className={styles.tableScroll}>
                  <table className={styles.runTable}>
                    <caption className={styles.agentDetail}>Execuções mais recentes de {agent.displayName}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Quando</th><th scope="col">Origem</th><th scope="col">Situação</th>
                        <th scope="col">Lidos</th><th scope="col">Processados</th><th scope="col">Ignorados</th>
                        <th scope="col">Falharam</th><th scope="col">Duração</th><th scope="col">Detalhe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run) => <tr key={run.id}>
                        <td>{formatDateTime(run.createdAt)}</td>
                        <td>{run.trigger === "scheduled" ? "Agendada" : run.trigger === "manual" ? "Manual" : run.trigger}</td>
                        <td>{runStatusLabel(run)}</td>
                        <td>{run.received}</td><td>{run.processed}</td><td>{run.skipped}</td><td>{run.failed}</td>
                        <td>{formatDuration(run.durationMs)}</td>
                        <td>
                          {run.logLines > 0 ? <button type="button" className={styles.ghostButton}
                            onClick={() => void loadLogs(agent.key, run.id)}>Ver log</button> : null}
                          {run.reprocessable && permissions?.reprocess ? <button type="button" className={styles.ghostButton}
                            disabled={busy === agent.key} onClick={() => void reprocess(agent, run)}>
                            <RotateCcw aria-hidden="true" />Reprocessar
                          </button> : null}
                        </td>
                      </tr>)}
                    </tbody>
                  </table>
                </div>

                {runsCursor ? <div className={styles.loadMore}>
                  <button type="button" className={styles.secondaryButton} disabled={busy === agent.key}
                    onClick={() => void loadRuns(agent.key, runsCursor)}>Carregar mais execuções</button>
                </div> : null}
              </>}

            {logRunId && logs.length ? <div className={styles.logList} aria-label="Log técnico da execução">
              {logs.map((line) => <div key={line.sequence} data-level={line.level}>
                <time dateTime={line.at}>{formatDateTime(line.at)}</time>
                <em>{line.phase}</em>
                <span>{line.message}</span>
              </div>)}
            </div> : null}
          </div> : null}
        </article>)}
      </div>}

    {confirmation ? <ConfirmDialog
      open
      title={confirmation.kind === "run" ? "Executar agora?"
        : confirmation.kind === "pause" ? "Pausar este agente?" : "Reativar este agente?"}
      consequence={confirmation.kind === "run"
        ? `${confirmation.agent.displayName} vai consultar o sistema de origem e pode abrir novas demandas. A execução acontece em segundo plano; a tela não fica travada esperando.`
        : confirmation.kind === "pause"
          ? `Enquanto estiver pausado, ${confirmation.agent.displayName} não lê nada e nenhuma proposta dele é considerada. O que já estava na fila continua valendo.`
          : `${confirmation.agent.displayName} volta a rodar na cadência configurada. A mudança fica registrada na auditoria com o seu nome.`}
      confirmLabel={confirmation.kind === "run" ? "Executar" : confirmation.kind === "pause" ? "Pausar" : "Reativar"}
      onCancel={() => setConfirmation(null)}
      onConfirm={() => {
        const current = confirmation;
        setConfirmation(null);
        if (!current) return;
        if (current.kind === "run") void runNow(current.agent);
        else void setEnabled(current.agent, current.kind === "resume");
      }}
    /> : null}
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className={styles.metric}><strong>{value}</strong><span>{label}</span></div>;
}

/**
 * Situação da execução em português, com o motivo quando falhou (§56).
 *
 * `RUN_FAILED` não diz nada para quem opera. "Falhou: o provedor recusou a
 * autenticação" diz o que aconteceu e sugere o que verificar.
 */
function runStatusLabel(run: AgentRun) {
  if (run.status === "succeeded") return "Concluída";
  if (run.status === "partial") return "Concluída com pendências";
  if (run.status === "queued") return "Na fila";
  if (run.status === "requires_user_action") return "Precisa de ação sua";
  if (run.status === "failed") {
    return <span title={run.errorCode}>
      <AlertTriangle aria-hidden="true" /> {run.errorMessage || "Falhou sem detalhe registrado"}
    </span>;
  }
  return run.summary || run.status;
}
