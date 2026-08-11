"use client";

import { KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertOctagon, AlertTriangle, Archive, ArrowRight, BadgeCheck, Cable, CheckCircle2,
  ChevronRight, CircleDot, Clock3, Database, GitCompareArrows, HardDrive, KeyRound,
  ListRestart, LoaderCircle, Mail, Map, MessageCircle, Network, Play, Plus, RefreshCw, RotateCw,
  Settings2, ShieldAlert, ShieldCheck, Unplug, UsersRound, Vault, Waypoints,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { IntegrationDrawer } from "./IntegrationDrawers";
import { normalizeOverview, normalizeRunDetail, requestJson, type Row } from "./integrations.api";
import type {
  Connector, IntegrationEditor, IntegrationRun, IntegrationsOverview, IntegrationTab, Mapping, RunDetail,
} from "./integrations.types";
import styles from "./integrations.module.css";

const tabs: Array<{ id: IntegrationTab; label: string; icon: typeof Cable }> = [
  { id: "connectors", label: "Conectores", icon: Cable },
  { id: "mappings", label: "Mapeamentos", icon: GitCompareArrows },
  { id: "runs", label: "Execuções", icon: ListRestart },
  { id: "reconciliations", label: "Conciliação", icon: Waypoints },
];

const channelIcons: Record<Connector["channel"], typeof Mail> = {
  email: Mail, whatsapp: MessageCircle, teams: UsersRound, drive: HardDrive,
  onedrive: HardDrive, solides: ShieldAlert, tangerino: ShieldAlert, erp: Database,
};
const statusLabels: Record<string, string> = {
  connected: "Conectado", needs_credentials: "Aguardando credenciais", paused: "Pausado", error: "Atenção",
  draft: "Rascunho", active: "Ativo", archived: "Arquivado", queued: "Na fila", running: "Em execução",
  succeeded: "Concluída", partial: "Parcial", failed: "Falhou", dead_letter: "Dead-letter",
  conflict: "Conflito", unmatched: "Sem vínculo", manual: "Manual", webhook: "Webhook",
};
const resourceLabels: Record<string, string> = { inbox: "Inbox", employees: "Colaboradores", hr_metrics: "Indicadores de RH", files: "Arquivos", admissions: "Admissões concluídas" };
const directionLabels: Record<string, string> = { inbound: "Entrada", outbound: "Saída", bidirectional: "Bidirecional" };
const credentialNames = ["token", "apiKey", "clientId", "clientSecret", "tenantId", "refreshToken", "phoneNumberId", "serviceAccount", "xToken"];
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const formatDate = (value: string) => {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(parsed);
};
const statusTone = (status: string) => ["connected", "active", "succeeded", "resolved"].includes(status) ? "safe" : ["error", "failed", "dead_letter", "conflict"].includes(status) ? "danger" : "warning";
const statusLabel = (status: string) => statusLabels[status] ?? status.replaceAll("_", " ");
const emptyOverview: IntegrationsOverview = { connectors: [], mappings: [], runs: [], reconciliations: [], queue: [], permissions: { manage: false, run: false, reconcile: false }, solidesBoundary: "" };

export function IntegrationsView({ role }: { role: WorkspaceRole }) {
  const [overview, setOverview] = useState<IntegrationsOverview>(emptyOverview);
  const [tab, setTab] = useState<IntegrationTab>("connectors");
  const [editor, setEditor] = useState<IntegrationEditor>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const loadOverview = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const payload = await requestJson<Row>("/api/integrations/overview");
      setOverview(normalizeOverview(payload)); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar integrações."); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => {
    if (role === "guest") return;
    let active = true;
    requestJson<Row>("/api/integrations/overview")
      .then((payload) => { if (active) { setOverview(normalizeOverview(payload)); setError(""); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Erro ao carregar integrações."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [role]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(""), 4200); return () => window.clearTimeout(timer); }, [toast]);

  const activeMappings = useMemo(() => overview.mappings.filter((item) => item.status === "active"), [overview.mappings]);
  const queueCount = overview.queue.filter((item) => ["queued", "processing", "retry"].includes(item.status)).reduce((sum, item) => sum + item.count, 0);
  const deadLetterCount = overview.queue.filter((item) => item.status === "dead_letter").reduce((sum, item) => sum + item.count, 0);
  const connected = overview.connectors.filter((item) => item.status === "connected").length;
  const connectorAttention = overview.connectors.filter((item) => item.status === "error" || item.status === "needs_credentials").length;
  const liveRuns = overview.runs.filter((item) => item.status === "queued" || item.status === "running").length;

  async function mutate(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try { await action(); setEditor(null); setDetail(null); setToast(success); await loadOverview(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação."); }
    finally { setBusy(false); }
  }

  async function submit(nextEditor: NonNullable<IntegrationEditor>, form: FormData) {
    if (nextEditor.kind === "configure") {
      const endpoint = field(form, "endpoint"); const accountReference = field(form, "accountReference");
      const admissionsSince = field(form, "admissionsSince"); const boardId = field(form, "boardId");
      const companyId = field(form, "companyId"); const pageSize = field(form, "pageSize");
      await mutate(() => requestJson(`/api/integrations/${nextEditor.connector.id}`, { method: "PATCH", body: JSON.stringify({ displayName: field(form, "displayName"), status: field(form, "status"), ...(endpoint ? { endpoint } : {}), ...(accountReference ? { accountReference } : {}), ...(admissionsSince ? { admissionsSince } : {}), ...(boardId ? { boardId } : {}), ...(companyId ? { companyId } : {}), ...(pageSize ? { pageSize: Number(pageSize) } : {}) }) }), "Configuração salva. A conexão ainda precisa ser verificada.");
      return;
    }
    if (nextEditor.kind === "credentials") {
      const credentials = Object.fromEntries(credentialNames.map((name) => [name, field(form, name)]).filter(([, value]) => value));
      await mutate(() => requestJson(`/api/integrations/${nextEditor.connector.id}/credentials`, { method: "PUT", body: JSON.stringify({ credentials }) }), nextEditor.connector.hasCredentials ? "Credencial rotacionada e campos limpos." : "Credencial guardada e campos limpos.");
      return;
    }
    if (nextEditor.kind === "revoke") {
      await mutate(() => requestJson(`/api/integrations/${nextEditor.connector.id}/credentials`, { method: "DELETE" }), "Credencial revogada."); return;
    }
    if (nextEditor.kind === "mapping") {
      const integrationId = field(form, "integrationId");
      const sources = form.getAll("source").map(String); const targets = form.getAll("target").map(String);
      const transforms = form.getAll("transform").map(String); const required = form.getAll("required").map(String);
      const fields = sources.map((source, index) => ({ source: source.trim(), target: targets[index]?.trim(), transform: transforms[index] || "identity", required: required[index] === "true" }));
      await mutate(() => requestJson(`/api/integrations/${integrationId}/mappings`, { method: "POST", body: JSON.stringify({ resourceType: field(form, "resourceType"), direction: field(form, "direction"), mapping: { externalIdField: field(form, "externalIdField"), fields } }) }), "Rascunho de mapeamento criado."); return;
    }
    if (nextEditor.kind === "run") {
      const integrationId = field(form, "integrationId");
      await mutate(() => requestJson(`/api/integrations/${integrationId}/runs`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ mappingId: field(form, "mappingId") }) }), "Execução enfileirada com chave de idempotência nova."); return;
    }
    if (nextEditor.kind === "reconciliation") {
      await mutate(() => requestJson(`/api/integrations/reconciliations/${nextEditor.reconciliation.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution: field(form, "resolution"), note: field(form, "note"), internalId: field(form, "internalId") }) }), "Conciliação resolvida e auditada.");
    }
  }

  async function verify(connector: Connector) {
    await mutate(() => requestJson(`/api/integrations/${connector.id}/verify`, { method: "POST" }), "Conexão verificada pelo provedor.");
  }

  async function publish(mapping: Mapping) {
    await mutate(() => requestJson(`/api/integrations/${mapping.integrationId}/mappings/${mapping.id}/publish`, { method: "POST" }), `Mapeamento v${mapping.version} publicado.`);
  }

  async function openDetail(run: IntegrationRun) {
    setEditor({ kind: "detail", run }); setDetail(null); setDetailError(""); setDetailLoading(true);
    try { const payload = await requestJson<Row>(`/api/integrations/runs/${run.id}`); setDetail(normalizeRunDetail(payload)); }
    catch (cause) { setDetailError(cause instanceof Error ? cause.message : "Erro ao carregar a execução."); }
    finally { setDetailLoading(false); }
  }

  function tabKeydown(event: KeyboardEvent<HTMLButtonElement>, current: number) {
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault(); setTab(tabs[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  }

  if (role === "guest") return null;
  if (loading) return <section className={styles.workspace}><div className={styles.loadingState}><LoaderCircle className={styles.spin} aria-hidden="true" /><strong>Ligando a central de integrações</strong><span>Consultando conectores, cofre, fila e conciliação…</span></div></section>;

  return <section className={styles.workspace}>
    <header className={styles.commandBar}>
      <div><span className={styles.eyebrow}>SWITCHBOARD OPERACIONAL</span><h2>Central de integrações</h2><p>Saúde, configuração e sincronização em um único ledger seguro.</p></div>
      <div className={styles.commandActions}><div className={styles.queueHealth} data-tone={deadLetterCount ? "danger" : queueCount ? "warning" : "safe"}><Activity aria-hidden="true" /><span><small>SAÚDE DA FILA</small><strong>{deadLetterCount ? `${deadLetterCount} dead-letter` : queueCount ? `${queueCount} em trânsito` : "Fluxo estável"}</strong></span></div><button className={styles.refreshButton} type="button" onClick={() => void loadOverview(true)} disabled={refreshing}><RefreshCw className={refreshing ? styles.spin : ""} aria-hidden="true" /> Atualizar</button></div>
    </header>

    {error && <div className={styles.errorBanner} role="alert"><AlertOctagon aria-hidden="true" /><span><strong>A central encontrou uma exceção</strong>{error}</span><button type="button" onClick={() => void loadOverview(true)}>Tentar novamente</button></div>}

    <ConnectionRail connectors={overview.connectors} activeMappings={activeMappings.length} queueCount={queueCount + liveRuns} reconciliations={overview.reconciliations.length} />
    <Kpis connected={connected} attention={connectorAttention} mappings={activeMappings.length} runs={liveRuns + queueCount} reconciliations={overview.reconciliations.length} />
    <aside className={styles.solidesBoundary}><ShieldAlert aria-hidden="true" /><div><strong>Sólides · fronteira permanente</strong><span>{overview.solidesBoundary || "O conector consome o recurso oficial de colaboradores e abre a conciliação de quem já foi admitido."} O Vinculato não realiza admissão digital.</span></div><b>SEM ATALHOS</b></aside>

    <div className={styles.tabs} role="tablist" aria-label="Áreas da Central de Integrações">
      {tabs.map((item, index) => { const Icon = item.icon; const selected = item.id === tab; return <button key={item.id} id={`integrations-tab-${item.id}`} role="tab" type="button" aria-selected={selected} aria-controls={`integrations-panel-${item.id}`} tabIndex={selected ? 0 : -1} className={selected ? styles.activeTab : ""} onClick={() => setTab(item.id)} onKeyDown={(event) => tabKeydown(event, index)}><Icon aria-hidden="true" />{item.label}<b>{tabCount(item.id, overview)}</b></button>; })}
    </div>
    <div className={styles.tabPanel} id={`integrations-panel-${tab}`} role="tabpanel" aria-labelledby={`integrations-tab-${tab}`} tabIndex={0}>
      {tab === "connectors" && <ConnectorsPanel overview={overview} busy={busy} onEdit={setEditor} onVerify={(connector) => void verify(connector)} />}
      {tab === "mappings" && <MappingsPanel overview={overview} busy={busy} onEdit={setEditor} onPublish={(mapping) => void publish(mapping)} />}
      {tab === "runs" && <RunsPanel overview={overview} onEdit={setEditor} onDetail={(run) => void openDetail(run)} />}
      {tab === "reconciliations" && <ReconciliationsPanel overview={overview} onEdit={setEditor} />}
    </div>

    {editor && <IntegrationDrawer key={`${editor.kind}-${"connector" in editor ? editor.connector.id : "run" in editor ? editor.run.id : "reconciliation" in editor ? editor.reconciliation.id : "new"}`} editor={editor} connectors={overview.connectors} mappings={overview.mappings} detail={detail} detailLoading={detailLoading} detailError={detailError} busy={busy} onClose={() => { setEditor(null); setDetail(null); setDetailError(""); }} onSubmit={submit} />}
    {toast && <div className={styles.toast} role="status"><CheckCircle2 aria-hidden="true" />{toast}</div>}
  </section>;
}

function ConnectionRail({ connectors, activeMappings, queueCount, reconciliations }: { connectors: Connector[]; activeMappings: number; queueCount: number; reconciliations: number }) {
  const stations = [
    { label: "Conector", detail: `${connectors.filter((item) => item.status === "connected").length} verificados`, count: connectors.length, icon: Cable, tone: "navy" },
    { label: "Cofre", detail: `${connectors.filter((item) => item.hasCredentials).length} credenciais`, count: connectors.filter((item) => !item.hasCredentials).length, icon: Vault, tone: "mint" },
    { label: "Mapeamento", detail: `${activeMappings} ativos`, count: activeMappings, icon: GitCompareArrows, tone: "navy" },
    { label: "Execução", detail: `${queueCount} em trânsito`, count: queueCount, icon: ListRestart, tone: queueCount ? "amber" : "mint" },
    { label: "Conciliação", detail: `${reconciliations} abertos`, count: reconciliations, icon: Waypoints, tone: reconciliations ? "violet" : "mint" },
  ];
  return <section className={styles.connectionRail} aria-label="Pulso operacional das integrações"><header><span><Network aria-hidden="true" /><strong>PULSO DE CONEXÃO</strong></span><small>Leitura ao vivo · esquerda → direita</small></header><ol>{stations.map((station, index) => { const Icon = station.icon; return <li key={station.label} data-tone={station.tone}><span className={styles.stationIndex}>{String(index + 1).padStart(2, "0")}</span><Icon aria-hidden="true" /><div><strong>{station.label}</strong><small>{station.detail}</small></div><b>{station.count}</b>{index < stations.length - 1 && <ChevronRight className={styles.railArrow} aria-hidden="true" />}</li>; })}</ol></section>;
}

function Kpis({ connected, attention, mappings, runs, reconciliations }: { connected: number; attention: number; mappings: number; runs: number; reconciliations: number }) {
  const metrics = [
    { label: "Conectores", value: connected, detail: `${attention} exigem atenção`, icon: BadgeCheck, tone: attention ? "warning" : "safe" },
    { label: "Mapeamentos ativos", value: mappings, detail: "versões publicadas", icon: Map, tone: "neutral" },
    { label: "Execuções em trânsito", value: runs, detail: "fila + processamento", icon: Activity, tone: runs ? "warning" : "safe" },
    { label: "Conflitos abertos", value: reconciliations, detail: "aguardam conciliação", icon: GitCompareArrows, tone: reconciliations ? "violet" : "safe" },
  ];
  return <section className={styles.kpis} aria-label="Indicadores de integrações">{metrics.map((metric) => { const Icon = metric.icon; return <article key={metric.label} data-tone={metric.tone}><span><Icon aria-hidden="true" /></span><div><small>{metric.label}</small><strong>{metric.value}</strong><em>{metric.detail}</em></div></article>; })}</section>;
}

function ConnectorsPanel({ overview, busy, onEdit, onVerify }: { overview: IntegrationsOverview; busy: boolean; onEdit: (editor: IntegrationEditor) => void; onVerify: (connector: Connector) => void }) {
  return <><PanelHeader eyebrow="RACK DE CANAIS" title="Conectores" text="Configuração, cofre e verificação real sem qualquer exposição de segredo." action={overview.permissions.manage && <button className={styles.secondaryButton} type="button" onClick={() => onEdit({ kind: "mapping" })}><Plus aria-hidden="true" /> Novo mapeamento</button>} />
    {overview.connectors.length ? <div className={styles.connectorRack}>{overview.connectors.map((connector) => { const Icon = channelIcons[connector.channel]; const active = overview.mappings.filter((item) => item.integrationId === connector.id && item.status === "active").length; return <article key={connector.id} data-status={connector.status}>
      <header><span className={styles.connectorIcon}><Icon aria-hidden="true" /></span><div><small>{connector.channel.toUpperCase()}</small><strong>{connector.displayName}</strong></div><StatusPill status={connector.status} /></header>
      <dl><div><dt>Credencial</dt><dd>{connector.hasCredentials ? <><KeyRound aria-hidden="true" /> v{connector.keyVersion} · {connector.fingerprint || "fingerprint protegido"}</> : <><Unplug aria-hidden="true" /> Não armazenada</>}</dd></div><div><dt>Verificação real</dt><dd>{formatDate(connector.verifiedAt)}</dd></div><div><dt>Última sincronização</dt><dd>{formatDate(connector.lastSyncAt)}</dd></div><div><dt>Mapeamentos ativos</dt><dd>{active}</dd></div></dl>
      {connector.lastError && <div className={styles.safeError}><AlertTriangle aria-hidden="true" /><span><strong>Resumo seguro</strong>{connector.lastError}</span></div>}
      {(connector.channel === "solides" || connector.channel === "tangerino") && <div className={styles.connectorBoundary}>Sem admissão digital · somente recurso oficial</div>}
      {overview.permissions.manage && <footer><button type="button" onClick={() => onEdit({ kind: "configure", connector })}><Settings2 aria-hidden="true" /> Configurar</button><button type="button" onClick={() => onEdit({ kind: "credentials", connector })}><RotateCw aria-hidden="true" />{connector.hasCredentials ? "Rotacionar" : "Credencial"}</button>{connector.hasCredentials && <button type="button" onClick={() => onEdit({ kind: "revoke", connector })}><Unplug aria-hidden="true" /> Revogar</button>}<button className={styles.verifyButton} type="button" disabled={!connector.hasCredentials || busy} onClick={() => onVerify(connector)}><ShieldCheck aria-hidden="true" /> Verificar</button></footer>}
    </article>; })}</div> : <EmptyState icon={Cable} title="Nenhum conector provisionado" text="Os conectores aparecerão aqui depois do provisionamento do workspace." />}
  </>;
}

function MappingsPanel({ overview, busy, onEdit, onPublish }: { overview: IntegrationsOverview; busy: boolean; onEdit: (editor: IntegrationEditor) => void; onPublish: (mapping: Mapping) => void }) {
  return <><PanelHeader eyebrow="LEDGER VERSIONADO" title="Mapeamentos" text="Estruturas publicadas alimentam execuções; rascunhos nunca rodam sozinhos." action={overview.permissions.manage && <button className={styles.primaryButton} type="button" onClick={() => onEdit({ kind: "mapping" })}><Plus aria-hidden="true" /> Novo rascunho</button>} />
    {overview.mappings.length ? <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th>Conector / recurso</th><th>Direção</th><th>Versão</th><th>Estado</th><th>Checksum</th><th>Publicação</th><th><span className={styles.srOnly}>Ações</span></th></tr></thead><tbody>{overview.mappings.map((mapping) => { const connector = overview.connectors.find((item) => item.id === mapping.integrationId); return <tr key={mapping.id}><td data-label="Conector / recurso"><strong>{connector?.displayName || "Conector"}</strong><small>{resourceLabels[mapping.resourceType] || mapping.resourceType}</small></td><td data-label="Direção">{directionLabels[mapping.direction] || mapping.direction}</td><td data-label="Versão"><strong className={styles.numeric}>v{mapping.version}</strong></td><td data-label="Estado"><StatusPill status={mapping.status} /></td><td data-label="Checksum"><code>{mapping.checksum ? mapping.checksum.slice(0, 12) : "—"}</code></td><td data-label="Publicação"><time>{formatDate(mapping.publishedAt || mapping.createdAt)}</time></td><td data-label="Ações"><div className={styles.rowActions}>{mapping.status === "draft" && overview.permissions.manage && <button className={styles.actionStrong} type="button" disabled={busy} onClick={() => onPublish(mapping)}><BadgeCheck aria-hidden="true" /> Publicar</button>}{mapping.status === "archived" && <span className={styles.mutedAction}><Archive aria-hidden="true" /> Histórico</span>}</div></td></tr>; })}</tbody></table></div> : <EmptyState icon={GitCompareArrows} title="Ledger sem mapeamentos" text="Crie um rascunho estruturado e publique a primeira versão para habilitar execuções." action={overview.permissions.manage && <button className={styles.primaryButton} type="button" onClick={() => onEdit({ kind: "mapping" })}><Plus aria-hidden="true" /> Criar rascunho</button>} />}
  </>;
}

function RunsPanel({ overview, onEdit, onDetail }: { overview: IntegrationsOverview; onEdit: (editor: IntegrationEditor) => void; onDetail: (run: IntegrationRun) => void }) {
  const canQueue = overview.permissions.run && overview.mappings.some((item) => item.status === "active");
  return <><PanelHeader eyebrow="CRONOLOGIA DA FILA" title="Execuções" text="Tentativas, contagens, retries e dead-letter em ordem operacional." action={overview.permissions.run && <button className={styles.primaryButton} type="button" disabled={!canQueue} onClick={() => onEdit({ kind: "run" })} title={!canQueue ? "Publique um mapeamento antes de executar" : undefined}><Play aria-hidden="true" /> Enfileirar execução</button>} />
    {overview.runs.length ? <div className={styles.runLedger}>{overview.runs.map((run) => <article key={run.id} data-tone={statusTone(run.status)}><span className={styles.timelineMark}><CircleDot aria-hidden="true" /></span><div className={styles.runIdentity}><small>{formatDate(run.createdAt)}</small><strong>{run.displayName}</strong><span>{statusLabel(run.triggerType)} · tentativa {run.attempt}</span></div><StatusPill status={run.status} /><div className={styles.runCounts}><span><b>{run.receivedCount}</b> recebidos</span><span><b>{run.processedCount}</b> processados</span><span><b>{run.conflictCount}</b> conflitos</span><span><b>{run.failedCount}</b> falhas</span></div><div className={styles.runSignal}>{run.attempt > 1 ? <><RefreshCw aria-hidden="true" /><span><strong>Retry</strong><small>{run.attempt} tentativas</small></span></> : <><Clock3 aria-hidden="true" /><span><strong>{run.completedAt ? "Finalizada" : "Em curso"}</strong><small>{formatDate(run.completedAt || run.startedAt)}</small></span></>}</div><button className={styles.detailButton} type="button" onClick={() => onDetail(run)}>Detalhes <ArrowRight aria-hidden="true" /></button></article>)}</div> : <EmptyState icon={ListRestart} title="Nenhuma execução registrada" text="As sincronizações manuais e por webhook aparecerão nesta linha do tempo." action={canQueue && <button className={styles.primaryButton} type="button" onClick={() => onEdit({ kind: "run" })}><Play aria-hidden="true" /> Primeira execução</button>} />}
  </>;
}

function ReconciliationsPanel({ overview, onEdit }: { overview: IntegrationsOverview; onEdit: (editor: IntegrationEditor) => void }) {
  return <><PanelHeader eyebrow="MESA DE EXCEÇÕES" title="Conciliação" text="Conflitos e itens sem vínculo, sempre resolvidos com justificativa auditável." />
    {!overview.permissions.reconcile ? <EmptyState icon={ShieldAlert} title="Visibilidade restrita" text="A conciliação fica disponível somente para pessoas com permissão de resolver conflitos." /> : overview.reconciliations.length ? <div className={styles.reconciliationList}>{overview.reconciliations.map((item) => <article key={item.id} data-status={item.status}><span className={styles.reconciliationIcon}>{item.status === "conflict" ? <GitCompareArrows aria-hidden="true" /> : <Unplug aria-hidden="true" />}</span><div><small>{item.displayName.toUpperCase()} · {item.entityType || "REGISTRO"}</small><strong>{item.status === "conflict" ? "Campos divergentes" : "Item sem vínculo interno"}</strong><span>{item.differenceFields.length ? item.differenceFields.join(" · ") : "Metadados disponíveis na resolução"}</span></div><StatusPill status={item.status} /><time>{formatDate(item.createdAt)}</time><button className={styles.primaryButton} type="button" onClick={() => onEdit({ kind: "reconciliation", reconciliation: item })}>Resolver <ArrowRight aria-hidden="true" /></button></article>)}</div> : <EmptyState icon={BadgeCheck} title="Conciliação em dia" text="Não há conflitos ou itens sem vínculo aguardando decisão." />}
  </>;
}

function PanelHeader({ eyebrow, title, text, action }: { eyebrow: string; title: string; text: string; action?: React.ReactNode }) {
  return <header className={styles.panelHeader}><div><span className={styles.eyebrow}>{eyebrow}</span><h3>{title}</h3><p>{text}</p></div>{action}</header>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={styles.statusPill} data-tone={statusTone(status)}><CircleDot aria-hidden="true" />{statusLabel(status)}</span>;
}

function EmptyState({ icon: Icon, title, text, action }: { icon: typeof Cable; title: string; text: string; action?: React.ReactNode }) {
  return <div className={styles.emptyState}><span><Icon aria-hidden="true" /></span><strong>{title}</strong><p>{text}</p>{action}</div>;
}

function tabCount(tab: IntegrationTab, overview: IntegrationsOverview) {
  if (tab === "connectors") return overview.connectors.length;
  if (tab === "mappings") return overview.mappings.filter((item) => item.status !== "archived").length;
  if (tab === "runs") return overview.runs.filter((item) => item.status === "queued" || item.status === "running").length;
  return overview.reconciliations.length;
}
