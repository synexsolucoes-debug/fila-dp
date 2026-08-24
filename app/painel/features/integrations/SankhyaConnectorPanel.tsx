"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot, CalendarClock, CheckCircle2, Clock3, Eye, KeyRound, LoaderCircle, Play, RefreshCw, Server,
  ShieldCheck, X,
} from "lucide-react";
import { requestJson } from "./integrations.api";
import type { Connector, IntegrationPermissions, IntegrationRun, IntegrationsOverview, SankhyaConfig } from "./integrations.types";
import { ErrorBanner, StatusPill } from "../shared";
import styles from "./integrations.module.css";

type Props = {
  connector: Connector;
  runs: IntegrationRun[];
  companies: IntegrationsOverview["companies"];
  permissions: IntegrationPermissions;
  refresh: () => Promise<void>;
};

type LogEntry = {
  id: string;
  run_id: string;
  level: string;
  phase: string;
  code: string;
  message: string;
  created_at: string;
};

const activeStatuses = new Set(["queued", "running", "authenticating", "navigating", "processing", "extracting", "importing"]);
const terminalSuccess = new Set(["succeeded", "partial"]);
const date = (value: string) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const duration = (milliseconds: number) => milliseconds ? `${Math.max(1, Math.round(milliseconds / 1000))}s` : "—";
const phaseLabel = (status: string) => ({
  queued: "Preparando", running: "Iniciando", authenticating: "Conectando", navigating: "Acessando DP Explorer",
  processing: "Consultando", extracting: "Extraindo", importing: "Importando", succeeded: "Concluído",
  partial: "Concluído parcialmente", failed: "Erro", requires_user_action: "Ação necessária", canceled: "Cancelado",
}[status] ?? status.replaceAll("_", " "));

const fallbackConfig: SankhyaConfig = {
  endpoint: "", companyId: "", companyContext: "", routine: "employees", routineName: "DP Explorer",
  automaticEnabled: false, frequency: "daily", scheduleTime: "02:00", scheduleWeekday: 1, timezone: "America/Sao_Paulo",
  timeoutMs: 300_000, maxAttempts: 3, downloadLimitBytes: 25 * 1024 * 1024, diagnosticRetentionHours: 24,
};

export function SankhyaConnectorPanel({ connector, runs, companies, permissions, refresh }: Props) {
  const config: SankhyaConfig = { ...fallbackConfig, ...(connector.config ?? {}) };
  const [pending, setPending] = useState<"test" | "sync" | "logs" | "">("");
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logRunId, setLogRunId] = useState("");

  const sankhyaRuns = useMemo(() => runs.filter((run) => run.integrationId === connector.id), [connector.id, runs]);
  const activeRun = sankhyaRuns.find((run) => activeStatuses.has(run.status));
  const latestRun = sankhyaRuns[0];

  useEffect(() => {
    if (!activeRun) return;
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [activeRun, refresh]);

  const act = async (kind: typeof pending, action: () => Promise<void>, success: string) => {
    setPending(kind); setFailure(""); setNotice("");
    try { await action(); setNotice(success); await refresh(); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : "Não foi possível concluir a operação."); }
    finally { setPending(""); }
  };

  const testConnection = () => void act("test", async () => {
    await requestJson(`/api/integrations/${connector.id}/verify`, { method: "POST" });
  }, "Teste de conexão enfileirado. O status será atualizado automaticamente.");

  const synchronize = () => void act("sync", async () => {
    await requestJson(`/api/integrations/${connector.id}/runs`, { method: "POST", body: "{}" });
  }, "Sincronização enfileirada. O acompanhamento já está ativo.");

  const openLogs = (runId: string) => void act("logs", async () => {
    const payload = await requestJson<{ logs?: LogEntry[] }>(`/api/integrations/${connector.id}/logs?runId=${encodeURIComponent(runId)}`);
    setLogs(Array.isArray(payload.logs) ? payload.logs : []); setLogRunId(runId);
  }, "Logs técnicos carregados sem conteúdo sensível.");

  return <section className={styles.sankhyaPanel} aria-labelledby="sankhya-title">
    <header className={styles.sankhyaHero}>
      <span className={styles.sankhyaMark}><Bot /></span>
      <div><span className={styles.eyebrow}>RPA · BROWSER AUTOMATION</span><h3 id="sankhya-title">Sankhya Browser Connector</h3><p>Consulta isolada por workspace, executada por navegador seguro e sem uso da API Sankhya.</p></div>
      <StatusPill status={connector.status} tone={connector.status === "connected" ? "safe" : connector.status === "error" ? "danger" : "warning"} label={phaseLabel(connector.status)} />
    </header>

    {(failure || connector.lastError) && <ErrorBanner title="O conector requer atenção" message={failure || connector.lastError} />}
    {notice && <div className={styles.successBanner}><CheckCircle2 /><span>{notice}</span></div>}
    <div className={styles.securityNotice}><ShieldCheck /><div><strong>Use um usuário dedicado de consulta</strong><span>Recomendamos utilizar um usuário exclusivo para integração, com acesso somente às rotinas necessárias. CAPTCHA e MFA nunca serão contornados.</span></div></div>

    <div className={styles.sankhyaGrid}>
      <article className={styles.sankhyaCard}>
        <header><Server /><div><strong>Conexão</strong><span>Ambiente e credenciais do workspace</span></div></header>
        <dl>
          <div><dt>URL</dt><dd>{config.endpoint || "Não configurada"}</dd></div>
          <div><dt>Usuário</dt><dd>{connector.publicHint || "Não configurado"}</dd></div>
          <div><dt>Senha</dt><dd>{connector.hasCredentials ? "••••••••••••" : "Não configurada"}</dd></div>
          <div><dt>Última conexão</dt><dd>{date(connector.lastConnectionAt)}</dd></div>
        </dl>
        <footer>
          <span className={styles.managedBadge}><KeyRound />Gerenciada pela Plataforma Global</span>
          {/* Credencial e configuração são gravadas por caminhos separados no
              console: dá para ter senha salva e configuração ainda recusada. Sem
              esta condição o botão ficava ativo e o servidor recusava por falta
              de URL — o "Não configurada" logo acima é a explicação. */}
          <button className={styles.primaryButton} disabled={!permissions.execute || !connector.hasCredentials || !config.endpoint || !config.companyId || Boolean(activeRun) || Boolean(pending)} onClick={testConnection}>{pending === "test" ? <LoaderCircle className={styles.spin} /> : <RefreshCw />}Testar conexão</button>
        </footer>
      </article>

      <article className={styles.sankhyaCard}>
        <header><Play /><div><strong>Sincronização</strong><span>Consulta de colaboradores no DP Explorer</span></div></header>
        <dl>
          <div><dt>Estado</dt><dd>{activeRun ? phaseLabel(activeRun.status) : "Disponível"}</dd></div>
          <div><dt>Última sincronização</dt><dd>{date(connector.lastSuccessfulSyncAt || connector.lastSyncAt)}</dd></div>
          <div><dt>Próxima sincronização</dt><dd>{config.automaticEnabled ? date(connector.nextSyncAt) : "Automação inativa"}</dd></div>
          <div><dt>Último resultado</dt><dd>{latestRun ? `${latestRun.processedCount} processados` : "Sem execuções"}</dd></div>
        </dl>
        <footer><button className={styles.primaryButton} disabled={!permissions.execute || connector.status !== "connected" || Boolean(activeRun) || Boolean(pending)} onClick={synchronize}>{pending === "sync" || activeRun ? <LoaderCircle className={styles.spin} /> : <Play />}{activeRun ? phaseLabel(activeRun.status) : "Sincronizar agora"}</button></footer>
      </article>
    </div>

    <section className={styles.sankhyaConfig}>
      <header><CalendarClock /><div><strong>Configuração e automação</strong><span>Somente leitura no workspace; alterações são feitas pela Plataforma Global.</span></div></header>
      <div className={styles.formGrid}>
        <label className={styles.fieldWide}><span>URL HTTPS do ambiente Sankhya</span><input type="url" value={config.endpoint} disabled placeholder="https://cliente.sankhya.com.br/" /></label>
        <label><span>Empresa Vinculato de destino</span><select value={config.companyId} disabled><option value="">Selecione</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
        <label><span>Empresa/contexto no Sankhya</span><input value={config.companyContext} disabled placeholder="Código ou nome exibido no login" /></label>
        <label><span>Rotina</span><input value={config.routineName} disabled /></label>
        <label><span>Timeout</span><select value={config.timeoutMs} disabled><option value={120000}>2 minutos</option><option value={300000}>5 minutos</option><option value={600000}>10 minutos</option><option value={900000}>15 minutos</option></select></label>
        <label><span>Máximo de tentativas</span><select value={config.maxAttempts} disabled><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
        <label><span>Frequência</span><select value={config.frequency} disabled><option value="hourly">A cada hora</option><option value="daily">Diariamente</option><option value="weekly">Semanalmente</option></select></label>
        <label><span>Horário</span><input type="time" value={config.scheduleTime} disabled /></label>
        {config.frequency === "weekly" && <label><span>Dia da semana</span><select value={config.scheduleWeekday} disabled><option value={1}>Segunda-feira</option><option value={2}>Terça-feira</option><option value={3}>Quarta-feira</option><option value={4}>Quinta-feira</option><option value={5}>Sexta-feira</option><option value={6}>Sábado</option><option value={0}>Domingo</option></select></label>}
        {/* Esta seção inteira é leitura: quem altera é a Plataforma Global. Um
            checkbox desabilitado mostrando o estado dava dois problemas de uma
            vez — 16×16 reprova o tamanho de alvo da WCAG 2.2, e o leitor de tela
            anunciava "caixa de seleção, não marcada, desabilitada" no lugar do
            fato. Nenhuma conferência media, porque a semente não liberava o
            módulo e a seção nunca chegava a ser pintada. */}
        <div className={styles.toggleField}><span>Sincronização automática</span>
          <StatusPill status={config.automaticEnabled ? "active" : "paused"} tone={config.automaticEnabled ? "safe" : "neutral"}
            label={config.automaticEnabled ? "Ativada" : "Desativada"} /></div>
      </div>
    </section>

    <section className={styles.sankhyaHistory}>
      <header><Clock3 /><div><strong>Histórico</strong><span>Execuções e resultados segregados deste workspace</span></div></header>
      <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th>Data</th><th>Tipo</th><th>Resultado</th><th>Duração</th><th>Registros</th><th>Detalhes</th></tr></thead><tbody>
        {sankhyaRuns.length ? sankhyaRuns.map((run) => <tr key={run.id}><td><time>{date(run.createdAt)}</time></td><td>{run.triggerType === "health_check" ? "Teste" : run.triggerType === "scheduled" ? "Automática" : "Manual"}</td><td><StatusPill status={run.status} tone={terminalSuccess.has(run.status) ? "safe" : run.status === "failed" ? "danger" : "warning"} label={phaseLabel(run.status)} /></td><td>{duration(run.durationMs)}</td><td>{run.processedCount} processados · {run.failedCount} erros</td><td><button className={styles.detailButton} disabled={!permissions.logsView || pending === "logs"} onClick={() => openLogs(run.id)}><Eye />Logs</button></td></tr>) : <tr><td colSpan={6}>Nenhuma execução registrada.</td></tr>}
      </tbody></table></div>
    </section>

    {logRunId && <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLogRunId(""); }}><aside className={`${styles.drawer} ${styles.drawerWide}`} role="dialog" aria-modal="true" aria-labelledby="sankhya-logs-title"><header className={styles.drawerHeader}><div><span className={styles.eyebrow}>DIAGNÓSTICO SEGURO</span><h2 id="sankhya-logs-title">Logs da execução</h2><p>Mensagens técnicas sanitizadas; credenciais, cookies e dados pessoais não são registrados.</p></div><button aria-label="Fechar" onClick={() => setLogRunId("")}><X /></button></header><div className={styles.drawerBody}><div className={styles.logList}>{logs.length ? logs.map((entry) => <article key={entry.id}><time>{date(entry.created_at)}</time><StatusPill status={entry.level} label={entry.phase || entry.level} /><div><strong>{entry.code || phaseLabel(entry.phase)}</strong><p>{entry.message}</p></div></article>) : <p>Nenhum log técnico disponível para esta execução.</p>}</div></div></aside></div>}
  </section>;
}
