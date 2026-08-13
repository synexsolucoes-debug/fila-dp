"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cable, CircleDot, Clock3, KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { normalizeOverview, requestJson, type Row } from "./integrations.api";
import type { IntegrationsOverview } from "./integrations.types";
import styles from "./integrations.module.css";

const empty: IntegrationsOverview = { connectors: [], mappings: [], runs: [], reconciliations: [], queue: [], permissions: { manage: false, run: false, reconcile: false }, solidesBoundary: "" };
const date = (value: string) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const tone = (status: string) => status === "connected" || status === "succeeded" ? "safe" : status === "error" || status === "failed" ? "danger" : "warning";

/** Estado operacional somente leitura. Configuração e credenciais vivem em /plataforma. */
export function IntegrationsView({ role }: { role: WorkspaceRole }) {
  const [overview, setOverview] = useState(empty); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); try { setOverview(normalizeOverview(await requestJson<Row>("/api/integrations/overview"))); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao carregar integrações."); } finally { setLoading(false); } }, []);
  useEffect(() => { if (role === "guest") return; const frame = window.requestAnimationFrame(() => void load()); return () => window.cancelAnimationFrame(frame); }, [load, role]);
  if (loading) return <section className={styles.workspace}><div className={styles.loadingState}><LoaderCircle className={styles.spin} /><strong>Carregando estado das integrações</strong></div></section>;
  const queue = overview.queue.reduce((sum, item) => sum + item.count, 0); const failures = overview.runs.filter((run) => run.status === "failed" || run.status === "partial").length;
  return <section className={styles.workspace}>
    <div className={styles.connectionRail}><header><span><Cable /><strong>ESTADO OPERACIONAL · SOMENTE LEITURA</strong></span><button className={styles.refreshButton} onClick={() => void load()}><RefreshCw />Atualizar</button></header></div>
    {error && <div className={styles.errorBanner}><AlertTriangle /><span><strong>Não foi possível consultar o estado</strong>{error}</span></div>}
    <div className={styles.kpis}><article data-tone="safe"><span><Cable /></span><div><small>Conectadas</small><strong>{overview.connectors.filter((item) => item.status === "connected").length}</strong><em>{overview.connectors.length} configuradas</em></div></article><article data-tone={queue ? "warning" : "safe"}><span><Clock3 /></span><div><small>Fila</small><strong>{queue}</strong><em>jobs persistidos</em></div></article><article data-tone={failures ? "warning" : "safe"}><span><AlertTriangle /></span><div><small>Falhas recentes</small><strong>{failures}</strong><em>execuções carregadas</em></div></article><article><span><KeyRound /></span><div><small>Administração</small><strong>Global</strong><em>fora deste painel</em></div></article></div>
    <section className={styles.tabPanel}><header className={styles.panelHeader}><div><span className={styles.eyebrow}>CONEXÕES DO WORKSPACE</span><h3>Disponibilidade e última sincronização</h3><p>Credenciais, mapeamentos, retries e revogações são administrados exclusivamente pela equipe autorizada da plataforma.</p></div></header>
      {overview.connectors.length ? <div className={styles.connectorRack}>{overview.connectors.map((connector) => <article key={connector.id} data-status={connector.status}><header><span className={styles.connectorIcon}><Cable /></span><div><small>{connector.channel.toUpperCase()}</small><strong>{connector.displayName}</strong></div><span className={styles.statusPill} data-tone={tone(connector.status)}><CircleDot />{connector.status.replaceAll("_", " ")}</span></header><dl><div><dt>Última sincronização</dt><dd><Clock3 />{date(connector.lastSyncAt)}</dd></div><div><dt>Credencial</dt><dd><KeyRound />{connector.hasCredentials ? "configurada" : "não configurada"}</dd></div></dl>{connector.lastError && <div className={styles.safeError}><AlertTriangle />{connector.lastError}</div>}</article>)}</div> : <div className={styles.emptyState}><span><Cable /></span><strong>Nenhuma integração configurada</strong><p>Não há conexão para acompanhar neste workspace.</p></div>}
    </section>
  </section>;
}
