"use client";

import styles from "../platform.module.css";
import { Empty, ErrorState, FeatureHeader, FeatureProps, Loading, MetricCard, Panel, Row, Status, date, number, text, usePlatformResource } from "./core";
import { WorkspaceConfiguration } from "./WorkspaceConfiguration";

export function OperationsFeature({ params, updateQuery }: FeatureProps) {
  const resource = usePlatformResource<Row>("/api/platform/operations");
  const summary = (resource.data?.summary ?? {}) as Row;
  const workspaces = Array.isArray(resource.data?.workspaces) ? resource.data.workspaces as Row[] : [];
  const selectedWorkspace = params.get("workspace") ?? "";
  const failures: Row[] = workspaces.flatMap((workspace) => {
    const recent = Array.isArray(workspace.recentFailures) ? workspace.recentFailures as Row[] : [];
    return recent.map((failure): Row => ({ ...failure, workspaceName: workspace.workspaceName }));
  });
  return <><FeatureHeader eyebrow="EXECUÇÃO E CONFIABILIDADE" title="Operações" description="Filas, retries, dead-letter, conciliação e configuração operacional por workspace." loading={resource.loading} onRefresh={resource.refresh} />
    {resource.loading && !resource.data ? <Loading /> : resource.error ? <ErrorState message={resource.error} retry={resource.refresh} /> : <>
      <section className={styles.metricGrid}><MetricCard label="Aguardando" value={number(summary.queued)} /><MetricCard label="Processando" value={number(summary.processing)} /><MetricCard label="Dead-letter" value={number(summary.deadLetter)} tone={number(summary.deadLetter) ? "danger" : "safe"} /><MetricCard label="Conflitos" value={number(summary.conflicts)} tone={number(summary.conflicts) ? "warning" : "safe"} /></section>
      <Panel title="Operação por workspace" subtitle="Contagens derivadas de jobs, execuções, conciliações e entregas persistidas."><div className={styles.tableWrap}><table><thead><tr><th>Workspace</th><th>Jobs</th><th>Execuções 24h</th><th>Conciliação</th><th>Webhooks 24h</th></tr></thead><tbody>{workspaces.map((row) => { const jobs = row.jobs as Row; const runs = row.runs24h as Row; const reconciliation = row.reconciliations as Row; const deliveries = row.deliveries24h as Row; return <tr key={text(row.workspaceId)}><td><strong>{text(row.workspaceName)}</strong></td><td>{number(jobs?.queued)} fila · {number(jobs?.leased)} execução · <Status value={number(jobs?.dead_letter) ? "dead_letter" : "ok"} /></td><td>{number(runs?.completed)} concluídas · {number(runs?.failed)} falhas</td><td>{number(reconciliation?.conflict) + number(reconciliation?.unmatched)} pendências</td><td>{number(deliveries?.delivered)} entregues · {number(deliveries?.failed) + number(deliveries?.dead_letter)} falhas</td></tr>; })}</tbody></table></div>{!workspaces.length && <Empty />}</Panel>
      <Panel title="Falhas recentes" subtitle="Mensagens saneadas, sem conteúdo de credenciais."><div className={styles.activityList}>{failures.slice(0, 30).map((row) => <article key={`${text(row.workspaceName)}:${text(row.id)}`}><Status value={text(row.status)} /><div><strong>{text(row.integration)} · {text(row.workspaceName)}</strong><small>{text(row.error) || `${number(row.failed)} item(ns) falharam`}</small></div><time>{date(row.createdAt)}</time></article>)}</div>{!failures.length && <Empty />}</Panel>
      <Panel title="Configuração operacional centralizada" subtitle="Grupo, empresas, fluxo, campos, templates, SLA, automações, acessos, módulos, chaves e webhooks."><div className={styles.workspacePicker}><label>Workspace<select value={selectedWorkspace} onChange={(event) => updateQuery({ workspace: event.target.value || null })}><option value="">Selecione um workspace</option>{workspaces.map((row) => <option key={text(row.workspaceId)} value={text(row.workspaceId)}>{text(row.workspaceName)}</option>)}</select></label><p>A seleção permanece na URL. Toda alteração exige revisão, motivo e confirmação.</p></div></Panel>
      {selectedWorkspace ? <WorkspaceConfiguration workspaceId={selectedWorkspace} /> : <Empty>Selecione um workspace para administrar sua configuração operacional.</Empty>}
    </>}
  </>;
}
