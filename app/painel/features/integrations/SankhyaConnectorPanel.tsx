"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity, AlertTriangle, Bot, CalendarClock, CheckCircle2, Clock3, Eye, KeyRound,
  LoaderCircle, Play, RefreshCw, Save, Server, ShieldCheck, X,
} from "lucide-react";
import { requestJson } from "./integrations.api";
import type { Connector, IntegrationPermissions, IntegrationRun, IntegrationsOverview, SankhyaConfig } from "./integrations.types";
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
  const [config, setConfig] = useState<SankhyaConfig>({ ...fallbackConfig, ...(connector.config ?? {}) });
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<"config" | "credentials" | "test" | "sync" | "logs" | "">("");
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

  const saveConfig = (event: FormEvent) => {
    event.preventDefault();
    void act("config", async () => {
      await requestJson(`/api/integrations/${connector.id}`, { method: "PATCH", body: JSON.stringify(config) });
    }, "Configuração Sankhya salva com segurança.");
  };

  const saveCredentials = (event: FormEvent) => {
    event.preventDefault();
    void act("credentials", async () => {
      await requestJson(`/api/integrations/${connector.id}/credentials`, {
        method: "PUT", body: JSON.stringify({ credentials: { username, password } }),
      });
      setUsername(""); setPassword(""); setCredentialsOpen(false);
    }, "Credenciais criptografadas e atualizadas. Execute o teste de conexão.");
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
      <span className={styles.statusPill} data-tone={connector.status === "connected" ? "safe" : connector.status === "error" ? "danger" : "warning"}><Activity />{phaseLabel(connector.status)}</span>
    </header>

    {(failure || connector.lastError) && <div className={styles.errorBanner}><AlertTriangle /><span><strong>O conector requer atenção</strong>{failure || connector.lastError}</span></div>}
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
          <button className={styles.secondaryButton} disabled={!permissions.credentialsManage || Boolean(pending)} onClick={() => setCredentialsOpen(true)}><KeyRound />Alterar credenciais</button>
          <button className={styles.primaryButton} disabled={!permissions.execute || !connector.hasCredentials || Boolean(activeRun) || Boolean(pending)} onClick={testConnection}>{pending === "test" ? <LoaderCircle className={styles.spin} /> : <RefreshCw />}Testar conexão</button>
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

    <form className={styles.sankhyaConfig} onSubmit={saveConfig}>
      <header><CalendarClock /><div><strong>Configuração e automação</strong><span>Somente valores operacionais; segredos são gravados no cofre separado.</span></div></header>
      <div className={styles.formGrid}>
        <label className={styles.fieldWide}><span>URL HTTPS do ambiente Sankhya</span><input type="url" required value={config.endpoint} disabled={!permissions.manage} onChange={(event) => setConfig((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://cliente.sankhya.com.br/" /></label>
        <label><span>Empresa Vinculato de destino</span><select required value={config.companyId} disabled={!permissions.manage} onChange={(event) => setConfig((current) => ({ ...current, companyId: event.target.value }))}><option value="">Selecione</option>{companies.map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
        <label><span>Empresa/contexto no Sankhya</span><input value={config.companyContext} disabled={!permissions.manage} onChange={(event) => setConfig((current) => ({ ...current, companyContext: event.target.value }))} placeholder="Código ou nome exibido no login" /></label>
        <label><span>Rotina</span><input value={config.routineName} disabled={!permissions.manage} onChange={(event) => setConfig((current) => ({ ...current, routineName: event.target.value }))} /></label>
        <label><span>Timeout</span><select value={config.timeoutMs} disabled={!permissions.manage} onChange={(event) => setConfig((current) => ({ ...current, timeoutMs: Number(event.target.value) }))}><option value={120000}>2 minutos</option><option value={300000}>5 minutos</option><option value={600000}>10 minutos</option><option value={900000}>15 minutos</option></select></label>
        <label><span>Máximo de tentativas</span><select value={config.maxAttempts} disabled={!permissions.manage} onChange={(event) => setConfig((current) => ({ ...current, maxAttempts: Number(event.target.value) }))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
        <label><span>Frequência</span><select value={config.frequency} disabled={!permissions.manage || !config.automaticEnabled} onChange={(event) => setConfig((current) => ({ ...current, frequency: event.target.value as SankhyaConfig["frequency"] }))}><option value="hourly">A cada hora</option><option value="daily">Diariamente</option><option value="weekly">Semanalmente</option></select></label>
        <label><span>Horário</span><input type="time" value={config.scheduleTime} disabled={!permissions.manage || !config.automaticEnabled} onChange={(event) => setConfig((current) => ({ ...current, scheduleTime: event.target.value }))} /></label>
        {config.frequency === "weekly" && <label><span>Dia da semana</span><select value={config.scheduleWeekday} disabled={!permissions.manage || !config.automaticEnabled} onChange={(event) => setConfig((current) => ({ ...current, scheduleWeekday: Number(event.target.value) }))}><option value={1}>Segunda-feira</option><option value={2}>Terça-feira</option><option value={3}>Quarta-feira</option><option value={4}>Quinta-feira</option><option value={5}>Sexta-feira</option><option value={6}>Sábado</option><option value={0}>Domingo</option></select></label>}
        <label className={styles.toggleField}><input type="checkbox" checked={config.automaticEnabled} disabled={!permissions.manage} onChange={(event) => setConfig((current) => ({ ...current, automaticEnabled: event.target.checked }))} /><span>Ativar sincronização automática</span></label>
      </div>
      {permissions.manage && <footer><button className={styles.primaryButton} disabled={Boolean(pending)} type="submit">{pending === "config" ? <LoaderCircle className={styles.spin} /> : <Save />}Salvar configuração</button></footer>}
    </form>

    <section className={styles.sankhyaHistory}>
      <header><Clock3 /><div><strong>Histórico</strong><span>Execuções e resultados segregados deste workspace</span></div></header>
      <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th>Data</th><th>Tipo</th><th>Resultado</th><th>Duração</th><th>Registros</th><th>Detalhes</th></tr></thead><tbody>
        {sankhyaRuns.length ? sankhyaRuns.map((run) => <tr key={run.id}><td><time>{date(run.createdAt)}</time></td><td>{run.triggerType === "health_check" ? "Teste" : run.triggerType === "scheduled" ? "Automática" : "Manual"}</td><td><span className={styles.statusPill} data-tone={terminalSuccess.has(run.status) ? "safe" : run.status === "failed" ? "danger" : "warning"}>{phaseLabel(run.status)}</span></td><td>{duration(run.durationMs)}</td><td>{run.processedCount} processados · {run.failedCount} erros</td><td><button className={styles.detailButton} disabled={!permissions.logsView || pending === "logs"} onClick={() => openLogs(run.id)}><Eye />Logs</button></td></tr>) : <tr><td colSpan={6}>Nenhuma execução registrada.</td></tr>}
      </tbody></table></div>
    </section>

    {credentialsOpen && <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCredentialsOpen(false); }}><aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="sankhya-credentials-title"><header className={styles.drawerHeader}><div><span className={styles.eyebrow}>COFRE DE CREDENCIAIS</span><h2 id="sankhya-credentials-title">Alterar credenciais Sankhya</h2><p>A senha será criptografada no backend e nunca será devolvida por esta interface.</p></div><button aria-label="Fechar" onClick={() => setCredentialsOpen(false)}><X /></button></header><form onSubmit={saveCredentials}><div className={styles.drawerBody}><div className={styles.securityNotice}><ShieldCheck /><div><strong>Credencial exclusiva deste workspace</strong><span>Outros workspaces, usuários sem permissão e o administrador global não recebem a senha em texto aberto.</span></div></div><div className={styles.formGrid}><label className={styles.fieldWide}><span>Usuário dedicado</span><input required minLength={2} autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} /></label><label className={styles.fieldWide}><span>Senha</span><input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></div></div><footer className={styles.drawerFooter}><button type="button" className={styles.secondaryButton} onClick={() => setCredentialsOpen(false)}>Cancelar</button><button className={styles.primaryButton} disabled={pending === "credentials"}>{pending === "credentials" ? <LoaderCircle className={styles.spin} /> : <KeyRound />}Criptografar e salvar</button></footer></form></aside></div>}

    {logRunId && <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLogRunId(""); }}><aside className={`${styles.drawer} ${styles.drawerWide}`} role="dialog" aria-modal="true" aria-labelledby="sankhya-logs-title"><header className={styles.drawerHeader}><div><span className={styles.eyebrow}>DIAGNÓSTICO SEGURO</span><h2 id="sankhya-logs-title">Logs da execução</h2><p>Mensagens técnicas sanitizadas; credenciais, cookies e dados pessoais não são registrados.</p></div><button aria-label="Fechar" onClick={() => setLogRunId("")}><X /></button></header><div className={styles.drawerBody}><div className={styles.logList}>{logs.length ? logs.map((entry) => <article key={entry.id}><time>{date(entry.created_at)}</time><span className={styles.statusPill}>{entry.phase || entry.level}</span><div><strong>{entry.code || phaseLabel(entry.phase)}</strong><p>{entry.message}</p></div></article>) : <p>Nenhum log técnico disponível para esta execução.</p>}</div></div></aside></div>}
  </section>;
}
