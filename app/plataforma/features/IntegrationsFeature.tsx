"use client";

import { ReactNode, useState } from "react";
import { ChevronRight, KeyRound, Lock, Pause, Play, RefreshCcw, RefreshCw, RotateCw, ShieldX, SlidersHorizontal, Unlock } from "lucide-react";
import styles from "../platform.module.css";
import { AdminAction, AdminActionDialog, Empty, ErrorState, FeatureHeader, FeatureProps, Loading, Notice, Panel, Row, Status, date, number, platformRequest, text, usePlatformResource } from "./core";
import { SankhyaPlatformConfiguration } from "./SankhyaPlatformConfiguration";

export function IntegrationsFeature({ params, updateQuery }: FeatureProps) {
  const workspace = params.get("workspace") ?? ""; const company = params.get("company") ?? ""; const connector = params.get("connector") ?? ""; const status = params.get("status") ?? ""; const cursor = params.get("cursor") ?? ""; const from = params.get("from") ?? ""; const to = params.get("to") ?? ""; const selected = params.get("integration") ?? "";
  const [action, setAction] = useState<AdminAction | null>(null); const [notice, setNotice] = useState("");
  const url = `/api/platform/integrations?${new URLSearchParams({ ...(workspace ? { workspaceId: workspace } : {}), ...(company ? { companyId: company } : {}), ...(connector ? { connector } : {}), ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(params.get("errors") === "true" ? { errors: "true" } : {}), ...(params.get("expiring") === "true" ? { expiring: "true" } : {}), ...(params.get("stalled") === "true" ? { stalled: "true" } : {}), ...(cursor ? { cursor } : {}), limit: "30" })}`;
  const resource = usePlatformResource<{ integrations: Row[]; sankhyaHealth?: Row; nextCursor?: string }>(url);
  function perform(row: Row, kind: string) {
    const displayName = text(row.displayName); const destructive = ["revoke_credential", "rotate_credential"].includes(kind);
    const labels: Row = { run: "Executar sincronização", retry: "Repetir execução", test_connection: "Testar conexão", pause: "Pausar integração", resume: "Retomar integração", revoke_credential: "Revogar credencial", rotate_credential: "Rotacionar credencial" };
    const consequences: Row = { run: "Uma execução manual será enfileirada com chave de idempotência própria.", retry: "Uma nova execução será criada a partir da falha selecionada.", test_connection: "O robô entrará no Sankhya com a credencial gravada. Se conseguir, o conector passa a aceitar sincronização; nenhum dado é importado nesta verificação.", pause: "Novas sincronizações ficarão impedidas até retomada explícita.", resume: "A integração voltará a aceitar jobs se houver credencial e mapeamento ativos.", revoke_credential: "A credencial ativa será revogada imediatamente e a integração exigirá nova configuração.", rotate_credential: "A credencial anterior será revogada e o novo segredo será cifrado antes de ser persistido." };
    setAction({ title: `${text(labels[kind])} · ${displayName}`, consequence: text(consequences[kind]), confirmLabel: text(labels[kind]), typedConfirmation: destructive ? displayName : undefined, credentialInput: kind === "rotate_credential", run: async ({ reason, confirmation, credentials }) => {
      const lastRun = (row.lastRun ?? {}) as Row;
      await platformRequest(`/api/platform/integrations/${encodeURIComponent(text(row.id))}/actions`, { method: "POST", headers: { "Idempotency-Key": `platform-${kind}-${crypto.randomUUID()}` }, body: JSON.stringify({ workspaceId: text(row.workspaceId), action: kind, reason, confirmed: true, confirmation, credentials, runId: text(lastRun.id), mappingId: text(((row.mapping ?? {}) as Row).id) }) });
      setNotice(`${text(labels[kind])} solicitada e auditada.`); resource.refresh();
    } });
  }
  const rows = resource.data?.integrations ?? [];
  /**
   * Leva à tela onde a liberação acontece, com o workspace já selecionado.
   *
   * O console listava o conector Sankhya de todo workspace e oferecia executar,
   * testar e configurar mesmo quando o módulo não estava liberado — o servidor
   * recusava no fim, com o formulário já preenchido. Explicar não basta: a tela
   * que aponta o defeito precisa abrir a porta para consertá-lo.
   */
  const openModuleGrant = (workspaceId: string) => updateQuery({ area: "operations", workspace: workspaceId,
    integration: null, connector: null, status: null, cursor: null, errors: null, expiring: null, stalled: null });
  return <><FeatureHeader eyebrow="GOVERNANÇA ENTRE CLIENTES" title="Integrações" description="Conexões, credenciais públicas, mapeamentos, execuções e filas por workspace." loading={resource.loading} onRefresh={resource.refresh} />{notice && <Notice>{notice}</Notice>}
    <div className={styles.filterBar}><input value={workspace} onChange={(event) => updateQuery({ workspace: event.target.value || null, cursor: null })} placeholder="ID do workspace" aria-label="Filtrar workspace" /><input value={company} onChange={(event) => updateQuery({ company: event.target.value || null, cursor: null })} placeholder="ID da empresa" aria-label="Filtrar empresa" /><select value={status} onChange={(event) => updateQuery({ status: event.target.value || null, cursor: null })}><option value="">Todos os status</option><option value="connected">Conectadas</option><option value="paused">Pausadas</option><option value="needs_credentials">Sem credencial</option><option value="error">Com erro</option></select><input value={connector} onChange={(event) => updateQuery({ connector: event.target.value || null, cursor: null })} placeholder="Conector" aria-label="Filtrar conector" /><input type="date" value={from} onChange={(event) => updateQuery({ from: event.target.value || null, cursor: null })} aria-label="Período inicial" /><input type="date" value={to} onChange={(event) => updateQuery({ to: event.target.value || null, cursor: null })} aria-label="Período final" /><label className={styles.checkFilter}><input type="checkbox" checked={params.get("errors") === "true"} onChange={(event) => updateQuery({ errors: event.target.checked ? "true" : null, cursor: null })} />Somente erros</label><label className={styles.checkFilter}><input type="checkbox" checked={params.get("expiring") === "true"} onChange={(event) => updateQuery({ expiring: event.target.checked ? "true" : null, cursor: null })} />Credenciais vencendo</label><label className={styles.checkFilter}><input type="checkbox" checked={params.get("stalled") === "true"} onChange={(event) => updateQuery({ stalled: event.target.checked ? "true" : null, cursor: null })} />Filas paradas</label></div>
    {resource.loading && !resource.data ? <Loading /> : resource.error ? <ErrorState message={resource.error} retry={resource.refresh} /> : <Panel title="Conexões globais" subtitle="Segredos nunca são retornados: somente fingerprint pública e versão."><div className={styles.integrationGrid}>{rows.map((row) => <IntegrationCard key={`${text(row.workspaceId)}:${text(row.id)}`} row={row} onDetail={() => updateQuery({ integration: text(row.id), workspace: text(row.workspaceId) })} onPerform={(kind) => perform(row, kind)} onEnableModule={() => openModuleGrant(text(row.workspaceId))} />)}</div>{!rows.length && <Empty />}<div className={styles.pagination}><button disabled={!cursor} onClick={() => updateQuery({ cursor: null })}>Primeira página</button><button disabled={!resource.data?.nextCursor} onClick={() => updateQuery({ cursor: resource.data?.nextCursor ?? null })}>Próxima página</button></div></Panel>}
    {selected && workspace && <IntegrationDetail integrationId={selected} workspaceId={workspace} onClose={() => updateQuery({ integration: null })} onEnableModule={() => openModuleGrant(workspace)} />}
    <AdminActionDialog action={action} onClose={() => setAction(null)} />
  </>;
}

function IntegrationCard({ row, onDetail, onPerform, onEnableModule }: { row: Row; onDetail: () => void; onPerform: (kind: string) => void; onEnableModule: () => void }) {
  const queue = (row.queue ?? {}) as Row; const run = (row.lastRun ?? {}) as Row; const health = (row.health ?? {}) as Row;
  const isSankhya = text(row.connector) === "sankhya_browser";
  // O conector Sankhya existe em todo workspace desde a migration 0038, mas o
  // módulo não vem em plano nenhum. Sem esta leitura o cartão oferecia executar
  // e testar em workspaces onde o servidor recusa — a tela prometendo o que o
  // servidor nega, que é o defeito que esta auditoria já corrigiu antes.
  const moduleBlocked = isSankhya && row.moduleEnabled === false;
  // Liberado, mas ainda sem URL ou sem empresa de destino gravadas: o servidor
  // recusa a execução do mesmo jeito. Oferecer "Executar" aqui foi o que fez a
  // recusa parecer dizer "você não preencheu o formulário" para quem tinha
  // acabado de preencher — e tido a gravação recusada sem perceber.
  const needsSetup = isSankhya && !moduleBlocked && row.configured === false;
  /**
   * A escada que o servidor aplica, na mesma ordem, antes de aceitar `run`:
   * módulo liberado → configuração gravada → credencial ativa → conector em
   * `connected`. Só o último degrau libera a sincronização, e quem sobe esse
   * degrau é o teste de conexão — gravar a senha não sobe, de propósito, porque
   * gravar não prova que a senha funciona.
   *
   * O cartão oferecia "Executar" em todos os degraus. Numa implantação real isso
   * custou várias tentativas: a recusa dizia "teste a conexão antes de
   * sincronizar" e o botão para testar estava dentro de outro painel, acima do
   * formulário que a pessoa tinha acabado de preencher. Agora o cartão oferece o
   * degrau seguinte, não o último.
   */
  const needsCredential = isSankhya && !moduleBlocked && !needsSetup && row.hasCredential === false;
  const needsTest = isSankhya && !moduleBlocked && !needsSetup && row.hasCredential === true
    && !["connected", "paused"].includes(text(row.status));
  const cannotRun = moduleBlocked || needsSetup || needsCredential || needsTest;
  return <article><header><div><span>{text(row.connector).toUpperCase()}</span><h3>{text(row.displayName)}</h3><p>{text(row.workspaceName)}{text(row.companyName) ? ` · ${text(row.companyName)}` : ""}</p></div><Status value={text(row.status)} /></header><dl><div><dt>Credencial</dt><dd>{row.hasCredential ? <><KeyRound aria-hidden="true" /> {text(row.fingerprint)} · v{number(row.credentialVersion)}</> : "Não configurada"}</dd></div><div><dt>Última execução</dt><dd>{run.id ? <><Status value={text(run.status)} /> {date(run.createdAt)}</> : "Sem execução"}</dd></div><div><dt>Fila</dt><dd>{number(queue.queued)} aguardando · {number(queue.processing)} processando · {number(queue.deadLetter)} DLQ</dd></div><div><dt>Conflitos</dt><dd>{number(row.conflicts)}</dd></div>{isSankhya && <div><dt>Saúde RPA</dt><dd>{number(health.successes)}/{number(health.runs)} sucessos · {number(health.authenticationErrors)} autenticação · {number(health.layoutErrors)} interface</dd></div>}</dl>{text(row.lastError) && <p className={styles.itemError}>{text(row.lastError)}</p>}{moduleBlocked && <div className={styles.inlineWarning}><Lock aria-hidden="true" /><span>Módulo não liberado neste workspace: executar, testar e configurar serão recusados.</span></div>}{needsSetup && <div className={styles.inlineWarning}><SlidersHorizontal aria-hidden="true" /><span>Configuração incompleta: falta a URL do ambiente ou a empresa de destino. Executar será recusado até a gravação ser concluída.</span></div>}{needsCredential && <div className={styles.inlineWarning}><KeyRound aria-hidden="true" /><span>Falta a credencial dedicada: grave usuário e senha em Configurar antes de testar a conexão.</span></div>}{needsTest && <div className={styles.inlineWarning}><RefreshCw aria-hidden="true" /><span>Ainda não conectado. Gravar a senha não prova que ela funciona — um teste de conexão bem-sucedido é o que libera a sincronização.</span></div>}<footer><button onClick={onDetail}>{isSankhya && !moduleBlocked ? "Configurar" : "Detalhes"} <ChevronRight aria-hidden="true" /></button>{moduleBlocked && <button onClick={onEnableModule}><Unlock aria-hidden="true" />Liberar módulo</button>}{needsTest && <button onClick={() => onPerform("test_connection")}><RefreshCw aria-hidden="true" />Testar conexão</button>}{!cannotRun && <><button onClick={() => onPerform("run")}><Play aria-hidden="true" />Executar</button>{["failed", "partial", "canceled"].includes(text(run.status)) && <button onClick={() => onPerform("retry")}><RefreshCcw aria-hidden="true" />Retry</button>}</>}{text(row.status) === "paused" ? <button onClick={() => onPerform("resume")}><Play aria-hidden="true" />Retomar</button> : <button onClick={() => onPerform("pause")}><Pause aria-hidden="true" />Pausar</button>}{!isSankhya && <button onClick={() => onPerform("rotate_credential")}><RotateCw aria-hidden="true" />Rotacionar</button>}<button data-danger="true" onClick={() => onPerform("revoke_credential")}><ShieldX aria-hidden="true" />Revogar</button></footer></article>;
}

function IntegrationDetail({ integrationId, workspaceId, onClose, onEnableModule }: { integrationId: string; workspaceId: string; onClose: () => void; onEnableModule: () => void }) {
  const [action, setAction] = useState<AdminAction | null>(null); const [notice, setNotice] = useState("");
  const resource = usePlatformResource<Row>(`/api/platform/integrations/${encodeURIComponent(integrationId)}/detail?workspaceId=${encodeURIComponent(workspaceId)}`);
  const integration = (resource.data?.integration ?? {}) as Row; const workspace = (resource.data?.workspace ?? {}) as Row;
  const list = (key: string) => Array.isArray(resource.data?.[key]) ? resource.data?.[key] as Row[] : [];
  async function send(kind: string, payload: Row, reason: string) {
    await platformRequest(`/api/platform/integrations/${encodeURIComponent(integrationId)}/actions`, { method: "POST", body: JSON.stringify({ ...payload, workspaceId, action: kind, reason, confirmed: true }) });
    setNotice("Ação concluída e registrada nas auditorias global e do workspace."); resource.refresh();
  }
  function createMapping() {
    setAction({ title: "Criar versão de mapeamento", consequence: "Uma nova versão em rascunho será criada; a integração continuará usando a versão ativa até publicação explícita.", confirmLabel: "Criar rascunho", jsonInput: { label: "Definição estruturada do mapeamento", hint: "Recursos aceitos: inbox, employees, hr_metrics, files e admissions. Transformações são validadas no servidor.", defaultValue: JSON.stringify({ resourceType: "employees", direction: "inbound", mapping: { externalIdField: "id", fields: [{ source: "id", target: "id", transform: "identity", required: true }] } }, null, 2) }, run: async ({ reason, jsonValue }) => {
      if (!jsonValue || typeof jsonValue !== "object" || Array.isArray(jsonValue)) throw new Error("Informe uma definição JSON válida.");
      await send("create_mapping", jsonValue as Row, reason);
    } });
  }
  function publishMapping(row: Row) {
    setAction({ title: `Publicar mapeamento v${number(row.version)}`, consequence: "A versão ativa anterior do mesmo recurso e direção será arquivada atomicamente.", confirmLabel: "Publicar versão", run: async ({ reason }) => send("publish_mapping", { mappingId: text(row.id) }, reason) });
  }
  function resolveReconciliation(row: Row) {
    setAction({ title: `Resolver conciliação ${text(row.id)}`, consequence: "A decisão atualizará a conciliação e o item sincronizado associado. Para link, informe internalId.", confirmLabel: "Registrar decisão", jsonInput: { label: "Decisão estruturada", hint: "resolution: link, accept_external, keep_internal ou ignore. O motivo administrativo também será usado como nota se note ficar vazio.", defaultValue: JSON.stringify({ resolution: "ignore", internalId: "", note: "" }, null, 2) }, run: async ({ reason, jsonValue }) => {
      if (!jsonValue || typeof jsonValue !== "object" || Array.isArray(jsonValue)) throw new Error("Informe uma decisão JSON válida.");
      const decision = jsonValue as Row;
      await send("resolve_reconciliation", { reconciliationId: text(row.id), ...decision, note: text(decision.note) || reason }, reason);
    } });
  }
  return <><div className={styles.detailOverlay}><aside className={styles.detailPane} role="dialog" aria-modal="true" aria-labelledby="integration-detail"><header><div><span>INTEGRAÇÃO GLOBAL</span><h2 id="integration-detail">{text(integration.display_name) || "Carregando…"}</h2><p>{text(workspace.name)}</p></div><button type="button" onClick={onClose}>Fechar</button></header>{resource.loading ? <Loading /> : resource.error ? <ErrorState message={resource.error} retry={resource.refresh} /> : <div className={styles.detailBody}>
    {notice && <Notice>{notice}</Notice>}
    {text(integration.channel) === "sankhya_browser" && <SankhyaPlatformConfiguration integration={integration} configuration={(resource.data?.configuration ?? {}) as Row} companies={list("companies")} credentials={list("credentials")} onSend={send} moduleEnabled={resource.data?.moduleEnabled !== false} moduleDisabledMessage={text(resource.data?.moduleDisabledMessage)} onEnableModule={onEnableModule} />}
    <dl className={styles.detailGrid}><div><dt>Canal</dt><dd>{text(integration.channel)}</dd></div><div><dt>Status</dt><dd><Status value={text(integration.status)} /></dd></div><div><dt>Empresa</dt><dd>{text(integration.company_name) || "Workspace"}</dd></div><div><dt>Última sincronização</dt><dd>{date(integration.last_sync_at)}</dd></div></dl>
    <DetailTable title="Credenciais" subtitle="Somente fingerprint, versão, validade e estado." headers={["Fingerprint", "Versão", "Estado", "Validade"]} rows={list("credentials")} render={(row) => <><td><code>{text(row.fingerprint)}</code></td><td>v{number(row.key_version)}</td><td><Status value={text(row.status)} /></td><td>{date(row.expires_at)}</td></>} />
    <DetailTable title="Mapeamentos versionados" subtitle="Rascunhos e versões publicadas, sem conteúdo sensível." actions={<button type="button" onClick={createMapping}>Novo rascunho</button>} headers={["Recurso", "Direção", "Versão", "Estado", "Ação"]} rows={list("mappings")} render={(row) => <><td>{text(row.resource_type)}</td><td>{text(row.direction)}</td><td>v{number(row.version)}</td><td><Status value={text(row.status)} /></td><td>{text(row.status) === "draft" ? <button type="button" onClick={() => publishMapping(row)}>Publicar</button> : "—"}</td></>} />
    <DetailTable title="Execuções recentes" subtitle="Origem, tentativas e contagens persistidas." headers={["Origem", "Estado", "Contagens", "Quando"]} rows={list("runs")} render={(row) => <><td>{text(row.trigger_type)}</td><td><Status value={text(row.status)} /></td><td>{number(row.processed_count)} processados · {number(row.conflict_count)} conflitos · {number(row.failed_count)} falhas</td><td>{date(row.created_at)}</td></>} />
    <DetailTable title="Conciliações" subtitle="Diferenças mostram apenas nomes de campos; valores permanecem omitidos." headers={["Entidade", "Diferenças", "Estado", "Quando", "Ação"]} rows={list("reconciliations")} render={(row) => <><td>{text(row.entity_type)}</td><td>{(Array.isArray(row.differenceFields) ? row.differenceFields.map(text) : []).join(", ") || "—"}</td><td><Status value={text(row.status)} /></td><td>{date(row.created_at)}</td><td>{["unmatched", "conflict"].includes(text(row.status)) ? <button type="button" onClick={() => resolveReconciliation(row)}>Resolver</button> : "—"}</td></>} />
  </div>}</aside></div><AdminActionDialog action={action} onClose={() => setAction(null)} /></>;
}

function DetailTable({ title, subtitle, actions, headers, rows, render }: { title: string; subtitle: string; actions?: ReactNode; headers: string[]; rows: Row[]; render: (row: Row) => ReactNode }) {
  return <section className={styles.detailSection}><div className={styles.detailSectionHeader}><h3>{title}</h3>{actions}</div><p className={styles.detailSubtitle}>{subtitle}</p>{rows.length ? <div className={styles.tableWrap}><table className={styles.detailTable}><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={text(row.id) || index}>{render(row)}</tr>)}</tbody></table></div> : <Empty />}</section>;
}
