"use client";

import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import type { PlatformArea } from "../PlatformApp";
import styles from "../platform.module.css";
import { ErrorState, FeatureHeader, Loading, MetricCard, Panel, Row, Status, date, money, number, text, usePlatformResource } from "./core";

export function OverviewFeature({ onNavigate }: { onNavigate: (area: PlatformArea) => void }) {
  const overview = usePlatformResource<Row>("/api/platform/overview");
  const billing = usePlatformResource<Row>("/api/platform/billing");
  const operations = usePlatformResource<Row>("/api/platform/operations");
  const loading = overview.loading || billing.loading || operations.loading;
  const refresh = () => { overview.refresh(); billing.refresh(); operations.refresh(); };
  if (loading && !overview.data) return <><FeatureHeader eyebrow="CENTRAL DE COMANDO" title="Visão geral" description="Estado real da plataforma, receita e pontos que exigem ação." loading onRefresh={refresh} /><Loading /></>;
  if (overview.error) return <><FeatureHeader eyebrow="CENTRAL DE COMANDO" title="Visão geral" description="Estado real da plataforma, receita e pontos que exigem ação." onRefresh={refresh} /><ErrorState message={overview.error} retry={refresh} /></>;
  const metrics = (overview.data?.metrics ?? {}) as Row; const billingMetrics = (billing.data?.metrics ?? {}) as Row; const op = (operations.data?.summary ?? {}) as Row;
  const attention = [
    { label: "Workspaces inadimplentes", value: number(metrics.pastDue ?? metrics.past_due), area: "billing" as const },
    { label: "Jobs em dead-letter", value: number(op.deadLetter), area: "operations" as const },
    { label: "Falhas de integração em 24h", value: number(op.failedRuns24h), area: "operations" as const },
    { label: "Webhooks falhos em 24h", value: number(op.failedWebhooks24h), area: "security" as const },
  ];
  const audits = Array.isArray(overview.data?.audits) ? overview.data.audits as Row[] : [];
  return <><FeatureHeader eyebrow="CENTRAL DE COMANDO" title="Visão geral" description="Estado real da plataforma, receita e pontos que exigem ação." loading={loading} onRefresh={refresh} />
    {(billing.error || operations.error) && <div className={styles.inlineWarning}><AlertTriangle aria-hidden="true" />Parte dos indicadores está indisponível: {billing.error || operations.error}</div>}
    <section className={styles.metricGrid} aria-label="Indicadores globais">
      <MetricCard label="Workspaces" value={number(metrics.workspaces).toLocaleString("pt-BR")} />
      <MetricCard label="Assinaturas ativas ou trial" value={number(metrics.subscribed).toLocaleString("pt-BR")} tone="safe" />
      <MetricCard label="MRR contratado" value={money(billingMetrics.mrrCents)} note="Assinaturas ativas no instante da consulta" tone="safe" />
      <MetricCard label="Receita em risco" value={money(billingMetrics.revenueAtRiskCents)} note="Past due + saldo em aberto" tone={number(billingMetrics.revenueAtRiskCents) ? "danger" : "safe"} />
    </section>
    <div className={styles.twoColumns}>
      <Panel title="Atenção necessária" subtitle="Contagens acionáveis; zero é estado saudável."><div className={styles.attentionList}>{attention.map((item) => <button type="button" key={item.label} onClick={() => onNavigate(item.area)} data-alert={item.value > 0}><span>{item.value > 0 ? <AlertTriangle aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}{item.label}</span><strong>{item.value}</strong><ArrowRight aria-hidden="true" /></button>)}</div></Panel>
      <Panel title="Métricas não disponíveis" subtitle="O console não inventa números sem histórico confiável."><dl className={styles.definitionList}>{[billingMetrics.mrrChange, billingMetrics.revenueChurn, billingMetrics.ltv].map((value, index) => { const item = value as Row | undefined; return <div key={index}><dt>{["Variação de MRR", "Churn de receita", "LTV"][index]}</dt><dd>{text(item?.reason) || "Dados insuficientes."}</dd></div>; })}</dl></Panel>
    </div>
    <Panel title="Atividade administrativa recente" subtitle="Eventos globais com ator, entidade e request id."><div className={styles.activityList}>{audits.length ? audits.slice(0, 12).map((row) => <article key={text(row.id)}><Status value="success" /><div><strong>{text(row.action).replaceAll(".", " › ")}</strong><small>{text(row.actor_email)} · {text(row.entity_type)} {text(row.entity_id).slice(0, 12)}</small></div><time>{date(row.created_at)}</time></article>) : <p className={styles.compactEmpty}>Nenhum evento administrativo recente.</p>}</div></Panel>
  </>;
}
