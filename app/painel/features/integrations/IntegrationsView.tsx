"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cable, Clock3, KeyRound, RefreshCw } from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { normalizeOverview, requestJson, type Row } from "./integrations.api";
import type { IntegrationsOverview } from "./integrations.types";
import { SankhyaConnectorPanel } from "./SankhyaConnectorPanel";
import { EmptyState, ErrorBanner, LoadingState, PanelHeader, StatusPill } from "../shared";
import styles from "./integrations.module.css";

const empty: IntegrationsOverview = {
  connectors: [], mappings: [], runs: [], reconciliations: [], queue: [], companies: [], sankhyaEnabled: false,
  permissions: { manage: false, run: false, reconcile: false, view: false, credentialsManage: false, execute: false, logsView: false },
  solidesBoundary: "",
};
const date = (value: string) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const tone = (status: string) => status === "connected" || status === "succeeded" ? "safe" : status === "error" || status === "failed" ? "danger" : "warning";

export function IntegrationsView({ role }: { role: WorkspaceRole }) {
  const [overview, setOverview] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
  if (loading) return <section className={styles.workspace}><LoadingState size="page" title="Carregando estado das integrações" text="Consultando conectores, fila e execuções recentes…" /></section>;

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

    <section className={styles.tabPanel}><PanelHeader eyebrow="OUTRAS CONEXÕES" title="Disponibilidade e última sincronização" description="Configuração sensível só aparece para usuários que possuam a permissão correspondente." />
      {standardConnectors.length ? <div className={styles.connectorRack}>{standardConnectors.map((connector) => <article key={connector.id} data-status={connector.status}><header><span className={styles.connectorIcon}><Cable /></span><div><small>{connector.channel.toUpperCase()}</small><strong>{connector.displayName}</strong></div><StatusPill status={connector.status} tone={tone(connector.status)} label={connector.status.replaceAll("_", " ")} /></header><dl><div><dt>Última sincronização</dt><dd><Clock3 />{date(connector.lastSyncAt)}</dd></div><div><dt>Credencial</dt><dd><KeyRound />{connector.hasCredentials ? "configurada" : "não configurada"}</dd></div></dl>{connector.lastError && <div className={styles.safeError}><AlertTriangle />{connector.lastError}</div>}</article>)}</div> : <EmptyState icon={Cable} title="Nenhuma outra integração configurada" text="O conector Sankhya, quando habilitado, aparece acima." />}
    </section>
  </section>;
}
