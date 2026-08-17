"use client";

import { useState, type FormEvent } from "react";
import { KeyRound, Lock, RefreshCw, Save, ShieldCheck, Unlock } from "lucide-react";
import styles from "../platform.module.css";
import { Row, Status, date, text } from "./core";

export type SankhyaPlatformConfig = {
  endpoint: string; companyId: string; companyContext: string; routine: "employees"; routineName: string;
  automaticEnabled: boolean; frequency: "hourly" | "daily" | "weekly"; scheduleTime: string; scheduleWeekday: number;
  timezone: string; timeoutMs: number; maxAttempts: number; downloadLimitBytes: number; diagnosticRetentionHours: number;
};

export const defaultSankhyaConfig: SankhyaPlatformConfig = {
  endpoint: "", companyId: "", companyContext: "", routine: "employees", routineName: "DP Explorer",
  automaticEnabled: false, frequency: "daily", scheduleTime: "02:00", scheduleWeekday: 1,
  timezone: "America/Sao_Paulo", timeoutMs: 300_000, maxAttempts: 3,
  downloadLimitBytes: 25 * 1024 * 1024, diagnosticRetentionHours: 24,
};

type Props = {
  integration: Row;
  configuration: Row;
  companies: Row[];
  credentials: Row[];
  onSend: (kind: string, payload: Row, reason: string) => Promise<void>;
  /** Liberação do módulo `sankhya_browser` para este workspace, lida do servidor. */
  moduleEnabled: boolean;
  /** A frase do próprio servidor, para a tela não escrever uma versão diferente. */
  moduleDisabledMessage: string;
  onEnableModule: () => void;
};

export function SankhyaPlatformConfiguration({ integration, configuration, companies, credentials, onSend, moduleEnabled, moduleDisabledMessage, onEnableModule }: Props) {
  const [config, setConfig] = useState<SankhyaPlatformConfig>({ ...defaultSankhyaConfig, ...configuration });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"config" | "credentials" | "test" | "">("");
  const [failure, setFailure] = useState("");
  const activeCredential = credentials.find((row) => text(row.status) === "active");
  const displayName = text(integration.display_name);
  const reasonValid = reason.trim().length >= 5;

  async function perform(kind: typeof pending, action: () => Promise<void>) {
    setPending(kind); setFailure("");
    try { await action(); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : "Não foi possível concluir a operação."); }
    finally { setPending(""); }
  }

  function saveConfig(event: FormEvent) {
    event.preventDefault();
    void perform("config", () => onSend("configure_sankhya", { config }, reason));
  }

  function saveCredentials(event: FormEvent) {
    event.preventDefault();
    void perform("credentials", async () => {
      await onSend("rotate_credential", { credentials: { username, password }, confirmation }, reason);
      setUsername(""); setPassword(""); setConfirmation("");
    });
  }

  function testConnection() {
    void perform("test", () => onSend("test_connection", {}, reason));
  }

  if (!moduleEnabled) {
    // Este era o fim do caminho que o defeito abria: o formulário aparecia
    // inteiro, aceitava endereço, empresa, usuário e senha, e só ao salvar o
    // servidor recusava por falta da liberação do módulo. Formulário que será
    // recusado não é formulário — é armadilha. Aqui a tela diz o mesmo que o
    // servidor diria e leva até onde a liberação é feita.
    return <section className={styles.detailSection} aria-labelledby="sankhya-platform-config">
      <div className={styles.detailSectionHeader}><h3 id="sankhya-platform-config">Configuração Sankhya do workspace</h3><Status value={text(integration.status)} /></div>
      <div className={styles.inlineWarning}><Lock aria-hidden="true" /><span>{moduleDisabledMessage || "O conector Sankhya ainda não está liberado para este workspace."}</span></div>
      <div className={styles.sankhyaSecretSummary}>
        <div><strong>O que a liberação destrava</strong><span>Endereço do ambiente, empresa de destino e agendamento passam a ser editáveis aqui.</span><span>Credencial dedicada, teste de conexão e execução manual passam a ser aceitos pelo servidor.</span></div>
        <button type="button" onClick={onEnableModule}><Unlock aria-hidden="true" />Liberar módulo</button>
      </div>
    </section>;
  }

  return <section className={styles.detailSection} aria-labelledby="sankhya-platform-config">
    <div className={styles.detailSectionHeader}><h3 id="sankhya-platform-config">Configuração Sankhya do workspace</h3><Status value={text(integration.status)} /></div>
    <div className={styles.sankhyaAdminIntro}><ShieldCheck aria-hidden="true" /><div><strong>Preparação exclusiva da Plataforma Global</strong><p>O usuário do workspace recebe a integração pronta. A senha é criptografada no backend e nunca volta para esta tela, API ou logs.</p></div></div>
    {failure && <p className={styles.itemError}>{failure}</p>}
    <label className={styles.sankhyaReason}><span>Motivo administrativo</span><input required minLength={5} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex.: implantação inicial do workspace" /></label>

    <form className={styles.configForm} onSubmit={saveConfig}>
      <label className={styles.fullField}><span>URL HTTPS do ambiente Sankhya</span><input type="url" required value={config.endpoint} onChange={(event) => setConfig((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://cliente.sankhya.com.br/" /></label>
      <label><span>Empresa Vinculato de destino</span><select required value={config.companyId} onChange={(event) => setConfig((current) => ({ ...current, companyId: event.target.value }))}><option value="">Selecione</option>{companies.map((company) => <option key={text(company.id)} value={text(company.id)}>{text(company.trade_name) || text(company.legal_name)}</option>)}</select></label>
      <label><span>Empresa/contexto no Sankhya</span><input value={config.companyContext} onChange={(event) => setConfig((current) => ({ ...current, companyContext: event.target.value }))} placeholder="Código ou nome exibido no login" /></label>
      <label><span>Rotina</span><input required value={config.routineName} onChange={(event) => setConfig((current) => ({ ...current, routineName: event.target.value }))} /></label>
      <label><span>Timeout</span><select value={config.timeoutMs} onChange={(event) => setConfig((current) => ({ ...current, timeoutMs: Number(event.target.value) }))}><option value={120000}>2 minutos</option><option value={300000}>5 minutos</option><option value={600000}>10 minutos</option><option value={900000}>15 minutos</option></select></label>
      <label><span>Máximo de tentativas</span><select value={config.maxAttempts} onChange={(event) => setConfig((current) => ({ ...current, maxAttempts: Number(event.target.value) }))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
      <label><span>Frequência</span><select value={config.frequency} disabled={!config.automaticEnabled} onChange={(event) => setConfig((current) => ({ ...current, frequency: event.target.value as SankhyaPlatformConfig["frequency"] }))}><option value="hourly">A cada hora</option><option value="daily">Diariamente</option><option value="weekly">Semanalmente</option></select></label>
      <label><span>Horário</span><input type="time" value={config.scheduleTime} disabled={!config.automaticEnabled} onChange={(event) => setConfig((current) => ({ ...current, scheduleTime: event.target.value }))} /></label>
      {config.frequency === "weekly" && <label><span>Dia da semana</span><select value={config.scheduleWeekday} disabled={!config.automaticEnabled} onChange={(event) => setConfig((current) => ({ ...current, scheduleWeekday: Number(event.target.value) }))}><option value={1}>Segunda-feira</option><option value={2}>Terça-feira</option><option value={3}>Quarta-feira</option><option value={4}>Quinta-feira</option><option value={5}>Sexta-feira</option><option value={6}>Sábado</option><option value={0}>Domingo</option></select></label>}
      <label className={`${styles.fullField} ${styles.confirmCheck}`}><input type="checkbox" checked={config.automaticEnabled} onChange={(event) => setConfig((current) => ({ ...current, automaticEnabled: event.target.checked }))} /><span>Ativar sincronização automática</span></label>
      <button type="submit" disabled={Boolean(pending) || !reasonValid}><Save aria-hidden="true" />{pending === "config" ? "Salvando…" : "Salvar configuração"}</button>
    </form>

    {/* Por que o botão está cinza.
        Salvar a credencial recarrega o painel, e o motivo administrativo — que
        fica lá em cima — volta vazio. O botão então desabilita logo depois da
        ação que deveria levar até ele, sem dizer nada. Numa implantação real
        isso travou o vínculo: a pessoa gravava a senha, encontrava o botão
        apagado e voltava a clicar em "Executar", que respondia "teste a conexão
        antes de sincronizar". Estado desabilitado sem explicação é um beco. */}
    <div className={styles.sankhyaSecretSummary}><div><strong>Credencial ativa</strong><span>Usuário: {text(activeCredential?.public_hint) || "não configurado"}</span><span>Senha: {activeCredential ? "••••••••••••" : "não configurada"}</span><span>Última conexão: {date(integration.last_connection_at)}</span>{!activeCredential ? <span>Grave a credencial abaixo para habilitar o teste.</span> : !reasonValid ? <span>Preencha o motivo administrativo acima para habilitar o teste.</span> : <span>É o teste que libera a sincronização.</span>}</div><button type="button" disabled={!activeCredential || Boolean(pending) || !reasonValid} onClick={testConnection}><RefreshCw aria-hidden="true" />{pending === "test" ? "Enfileirando…" : "Testar conexão"}</button></div>
    <form className={styles.configForm} onSubmit={saveCredentials}>
      <label><span>Usuário dedicado Sankhya</span><input required minLength={2} autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <label><span>Nova senha</span><input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label className={styles.fullField}><span>Confirme digitando “{displayName}”</span><input required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <button type="submit" disabled={Boolean(pending) || !reasonValid || confirmation !== displayName}><KeyRound aria-hidden="true" />{pending === "credentials" ? "Criptografando…" : "Criptografar e salvar"}</button>
    </form>
  </section>;
}
