"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cable, CheckCircle2, Clock3, KeyRound, RefreshCw, RotateCw, Settings2, ShieldCheck, Unplug } from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { IntegrationDrawer } from "./IntegrationDrawers";
import { normalizeOverview, requestJson, type Row } from "./integrations.api";
import type { Connector, IntegrationEditor, IntegrationsOverview, StandardConnectorConfig } from "./integrations.types";
import { SankhyaConnectorPanel } from "./SankhyaConnectorPanel";
import { EmptyState, ErrorBanner, PageSkeleton, PanelHeader, StatusPill } from "../shared";
import styles from "./integrations.module.css";

const empty: IntegrationsOverview = {
  connectors: [], mappings: [], runs: [], reconciliations: [], queue: [], companies: [], sankhyaEnabled: false,
  permissions: { manage: false, run: false, reconcile: false, view: false, credentialsManage: false, execute: false, logsView: false },
  solidesBoundary: "",
};
const date = (value: string) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const tone = (status: string) => status === "connected" || status === "succeeded" ? "safe" : status === "error" || status === "failed" ? "danger" : "warning";
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const credentialNames = ["token", "apiKey", "clientId", "clientSecret", "tenantId", "refreshToken", "phoneNumberId", "serviceAccount", "xToken"];
type WebhookSetup = { secret: string; webhookUrl: string; header: string; notice: string };

export function IntegrationsView({ role }: { role: WorkspaceRole }) {
  const [overview, setOverview] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<IntegrationEditor>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [webhookSetup, setWebhookSetup] = useState<WebhookSetup | null>(null);
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { setOverview(normalizeOverview(await requestJson<Row>("/api/integrations/overview"))); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao carregar integrações."); }
    finally { if (!silent) setLoading(false); }
  }, []);
  const refresh = useCallback(() => load(true), [load]);
  useEffect(() => {
    if (role === "guest") return;
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load, role]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function mutate(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      setEditor(null);
      setToast(success);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
    } finally { setBusy(false); }
  }

  async function submit(nextEditor: NonNullable<IntegrationEditor>, form: FormData) {
    if (nextEditor.kind === "configure") {
      const endpoint = field(form, "endpoint");
      const accountReference = field(form, "accountReference");
      const admissionsSince = field(form, "admissionsSince");
      const boardId = field(form, "boardId");
      const companyId = field(form, "companyId");
      const pageSize = field(form, "pageSize");
      const teams = nextEditor.connector.channel === "teams";
      await mutate(() => requestJson(`/api/integrations/${nextEditor.connector.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: field(form, "displayName"), status: field(form, "status"), endpoint,
          ...(accountReference ? { accountReference } : {}), ...(admissionsSince ? { admissionsSince } : {}),
          ...(boardId ? { boardId } : {}), ...(companyId ? { companyId } : {}), ...(pageSize ? { pageSize: Number(pageSize) } : {}),
          ...(teams ? {
            tenantId: field(form, "tenantId"), teamId: field(form, "teamId"), teamName: field(form, "teamName"),
            channelId: field(form, "channelId"), channelName: field(form, "channelName"),
            automations: {
              admission: form.has("automationAdmission"), termination: form.has("automationTermination"),
              warning: form.has("automationWarning"), role_change: form.has("automationRole"),
              salary_change: form.has("automationSalary"),
            },
          } : {}),
        }),
      }), teams ? "Canal do Teams salvo. Agora gere o webhook seguro." : "Configuração salva. Agora guarde a credencial e teste a conexão.");
      return;
    }
    if (nextEditor.kind === "credentials") {
      if (nextEditor.connector.channel === "teams") {
        setBusy(true);
        try {
          const setup = await requestJson<WebhookSetup>(`/api/integrations/${nextEditor.connector.id}/webhook-secret`, { method: "POST" });
          setWebhookSetup(setup);
          setEditor(null);
          setError("");
          await load(true);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Não foi possível gerar o webhook do Teams.");
        } finally { setBusy(false); }
        return;
      }
      const credentials = Object.fromEntries(credentialNames.map((name) => [name, field(form, name)]).filter(([, value]) => value));
      await mutate(() => requestJson(`/api/integrations/${nextEditor.connector.id}/credentials`, { method: "PUT", body: JSON.stringify({ credentials }) }), nextEditor.connector.hasCredentials ? "Credencial rotacionada e campos limpos." : "Credencial guardada e campos limpos. Agora teste a conexão.");
      return;
    }
    if (nextEditor.kind === "revoke") {
      await mutate(() => requestJson(`/api/integrations/${nextEditor.connector.id}/credentials`, { method: "DELETE" }), "Credencial revogada.");
    }
  }

  async function verify(connector: Connector) {
    await mutate(() => requestJson(`/api/integrations/${connector.id}/verify`, { method: "POST" }), "Conexão testada e verificada pelo provedor.");
  }

  if (loading) return <section className={styles.workspace}><PageSkeleton label="Carregando o estado das integrações" metrics={3} rows={4} /></section>;

  const queue = overview.queue.reduce((sum, item) => sum + item.count, 0);
  const failures = overview.runs.filter((run) => run.status === "failed" || run.status === "partial").length;
  const sankhya = overview.connectors.find((connector) => connector.channel === "sankhya_browser");
  const standardConnectors = overview.connectors.filter((connector) => connector.channel !== "sankhya_browser");

  return <section className={styles.workspace}>
    <div className={styles.connectionRail}><header><span><Cable /><strong>INTEGRAÇÕES DO WORKSPACE</strong><small>Dados e credenciais segregados por organização</small></span><button className={styles.refreshButton} onClick={() => void load()}><RefreshCw />Atualizar</button></header></div>
    {error && <ErrorBanner title="Não foi possível consultar o estado" message={error} />}
    <div className={styles.kpis}>
      <article data-tone="safe"><span><Cable /></span><div><small>Conectadas</small><strong>{overview.connectors.filter((item) => item.status === "connected").length}</strong><em>{overview.connectors.length} configuradas</em></div></article>
      <article data-tone={queue ? "warning" : "safe"}><span><Clock3 /></span><div><small>Fila</small><strong>{queue}</strong><em>jobs persistidos</em></div></article>
      <article data-tone={failures ? "warning" : "safe"}><span><AlertTriangle /></span><div><small>Falhas recentes</small><strong>{failures}</strong><em>execuções carregadas</em></div></article>
      <article><span><KeyRound /></span><div><small>Segurança</small><strong>Tenant</strong><em>isolamento por workspace</em></div></article>
    </div>

    {sankhya && <SankhyaConnectorPanel connector={sankhya} runs={overview.runs} companies={overview.companies} permissions={overview.permissions} refresh={refresh} />}

    <section className={styles.tabPanel}><PanelHeader eyebrow="OUTRAS CONEXÕES" title="Configuração e teste do piloto" description="Em cada conector: salve o endpoint oficial, guarde a credencial no cofre e faça uma verificação real antes de sincronizar." />
      {standardConnectors.length ? <div className={styles.connectorRack}>{standardConnectors.map((connector) => {
        const config = (connector.config ?? {}) as StandardConnectorConfig;
        const isTeams = connector.channel === "teams";
        const configured = isTeams ? Boolean(config.teamId && config.channelId) : Boolean(config.endpoint);
        const credentialReady = isTeams ? connector.hasWebhookSecret : connector.hasCredentials;
        const canManage = overview.permissions.manage;
        const permissionTitle = canManage ? undefined : "Seu perfil não possui permissão para gerenciar integrações.";
        return <article key={connector.id} data-status={connector.status}><header><span className={styles.connectorIcon}><Cable /></span><div><small>{connector.channel.toUpperCase()}</small><strong>{connector.displayName}</strong></div><StatusPill status={connector.status} tone={tone(connector.status)} label={connector.status.replaceAll("_", " ")} /></header>
          <div className={styles.pilotFlow} aria-label="Etapas do piloto"><span data-done={configured}><b>1</b>Configurar</span><span data-done={credentialReady}><b>2</b>{isTeams ? "Webhook" : "Credencial"}</span><span data-done={connector.status === "connected"}><b>3</b>{isTeams ? "Receber evento" : "Testar"}</span></div>
          <dl><div><dt>Configuração</dt><dd><Settings2 />{configured ? (isTeams ? "canal salvo" : "endpoint salvo") : "pendente"}</dd></div><div><dt>{isTeams ? "Webhook" : "Credencial"}</dt><dd><KeyRound />{credentialReady ? "configurado" : "não configurado"}</dd></div><div><dt>{isTeams ? "Último evento" : "Última verificação"}</dt><dd><ShieldCheck />{date(isTeams ? connector.lastSyncAt : connector.verifiedAt)}</dd></div><div><dt>Última sincronização</dt><dd><Clock3 />{date(connector.lastSyncAt)}</dd></div></dl>
          {connector.lastError && <div className={styles.safeError}><AlertTriangle />{connector.lastError}</div>}
          <footer><button type="button" disabled={!canManage || busy} title={permissionTitle} onClick={() => setEditor({ kind: "configure", connector })}><Settings2 />Configurar</button><button type="button" disabled={!canManage || busy} title={permissionTitle} onClick={() => setEditor({ kind: "credentials", connector })}><RotateCw />{isTeams ? (credentialReady ? "Rotacionar webhook" : "Gerar webhook") : (connector.hasCredentials ? "Rotacionar" : "Credencial")}</button>{!isTeams && connector.hasCredentials && <button type="button" disabled={!canManage || busy} title={permissionTitle} onClick={() => setEditor({ kind: "revoke", connector })}><Unplug />Revogar</button>}{isTeams ? <span className={styles.managedBadge}><ShieldCheck />{connector.status === "connected" ? "Evento autenticado recebido" : "Aguardando evento do fluxo"}</span> : <button className={styles.verifyButton} type="button" disabled={!canManage || !configured || !connector.hasCredentials || busy} title={!canManage ? permissionTitle : !configured ? "Salve a configuração antes de testar." : !connector.hasCredentials ? "Guarde a credencial antes de testar." : "Faz uma requisição real ao provedor."} onClick={() => void verify(connector)}><ShieldCheck />Testar conexão</button>}</footer>
        </article>;
      })}</div> : <EmptyState icon={Cable} title="Nenhuma outra integração configurada" text="O conector Sankhya, quando habilitado, aparece acima." />}
    </section>
    {editor && <IntegrationDrawer key={`${editor.kind}-${"connector" in editor ? editor.connector.id : "new"}`} editor={editor} connectors={overview.connectors} mappings={overview.mappings} detail={null} detailLoading={false} detailError="" companies={overview.companies} busy={busy} onClose={() => setEditor(null)} onSubmit={submit} />}
    {webhookSetup && <div className={styles.overlay} role="presentation"><section className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="teams-webhook-title"><header className={styles.drawerHeader}><div><span className={styles.eyebrow}>TEAMS · POWER AUTOMATE</span><h2 id="teams-webhook-title">Webhook gerado</h2><p>Copie os três valores agora. O segredo não será mostrado novamente.</p></div></header><div className={styles.drawerBody}><section className={styles.formSection}><div className={styles.formGrid}><label className={styles.fieldWide}><span>URL do webhook</span><input readOnly value={webhookSetup.webhookUrl} onFocus={(event) => event.currentTarget.select()} /></label><label className={styles.fieldWide}><span>Cabeçalho</span><input readOnly value={webhookSetup.header} onFocus={(event) => event.currentTarget.select()} /></label><label className={styles.fieldWide}><span>Segredo (copie agora)</span><input readOnly value={webhookSetup.secret} onFocus={(event) => event.currentTarget.select()} /></label></div><aside className={styles.securityNotice}><KeyRound /><div><strong>Configure a ação HTTP do Power Automate</strong><span>Método POST, corpo da mensagem em JSON e o cabeçalho acima com este segredo.</span></div></aside></section></div><footer className={styles.drawerFooter}><button className={styles.primaryButton} type="button" onClick={() => setWebhookSetup(null)}>Já copiei e configurei</button></footer></section></div>}
    {toast && <div className={styles.toast} role="status"><CheckCircle2 />{toast}</div>}
  </section>;
}

