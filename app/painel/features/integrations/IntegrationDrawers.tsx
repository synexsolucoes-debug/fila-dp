"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, Cable, CircleDot, GitCompareArrows, KeyRound, ListRestart,
  LoaderCircle, Plus, Trash2, Vault, X,
} from "lucide-react";
import type { Connector, IntegrationEditor, Mapping, RunDetail } from "./integrations.types";
import styles from "./integrations.module.css";

type Props = {
  editor: NonNullable<IntegrationEditor>;
  connectors: Connector[];
  mappings: Mapping[];
  detail: RunDetail | null;
  detailLoading: boolean;
  detailError: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (editor: NonNullable<IntegrationEditor>, data: FormData) => Promise<void>;
};

const titles: Record<NonNullable<IntegrationEditor>["kind"], string> = {
  configure: "Configurar conector", credentials: "Guardar credencial", revoke: "Revogar credencial",
  mapping: "Novo mapeamento", run: "Enfileirar execução", reconciliation: "Resolver conciliação",
  detail: "Detalhe da execução",
};

const credentialFields: Record<Connector["channel"], Array<{ name: string; label: string }>> = {
  email: [{ name: "apiKey", label: "Chave da API" }],
  whatsapp: [{ name: "token", label: "Token de acesso" }, { name: "phoneNumberId", label: "ID do número" }],
  teams: [{ name: "clientId", label: "Client ID" }, { name: "clientSecret", label: "Client secret" }, { name: "tenantId", label: "Tenant ID" }],
  drive: [{ name: "token", label: "Token de acesso" }],
  onedrive: [{ name: "clientId", label: "Client ID" }, { name: "clientSecret", label: "Client secret" }, { name: "tenantId", label: "Tenant ID" }],
  solides: [{ name: "token", label: "Token oficial" }],
  erp: [{ name: "apiKey", label: "Chave da API" }, { name: "xToken", label: "X-Token" }],
};

const formatDate = (value: string) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";

export function IntegrationDrawer({ editor, connectors, mappings, detail, detailLoading, detailError, busy, onClose, onSubmit }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  useEffect(() => { busyRef.current = busy; closeRef.current = onClose; }, [busy, onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const selector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    const focusables = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(selector) ?? []).filter((item) => item.getClientRects().length > 0);
    const timer = window.setTimeout(() => (panelRef.current?.querySelector<HTMLElement>("input:not([type='hidden']), select, textarea") ?? focusables()[0])?.focus(), 30);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) { event.preventDefault(); panelRef.current?.focus(); return; }
      const first = items[0]; const last = items.at(-1)!; const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(editor, new FormData(event.currentTarget));
  }

  const description = drawerDescription(editor);
  return (
    <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className={`${styles.drawer} ${editor.kind === "mapping" || editor.kind === "detail" ? styles.drawerWide : ""}`} ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="integration-drawer-title" aria-describedby="integration-drawer-description" tabIndex={-1}>
        <header className={styles.drawerHeader}>
          <div><span className={styles.eyebrow}>CENTRAL · CONTROLE SEGURO</span><h2 id="integration-drawer-title">{titles[editor.kind]}</h2><p id="integration-drawer-description">{description}</p></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fechar painel"><X aria-hidden="true" /></button>
        </header>
        {editor.kind === "detail" ? <RunDetailPanel detail={detail} loading={detailLoading} error={detailError} /> : (
          <form onSubmit={submit}>
            <div className={styles.drawerBody}>
              {editor.kind === "configure" && <ConfigureFields connector={editor.connector} />}
              {editor.kind === "credentials" && <CredentialFields connector={editor.connector} />}
              {editor.kind === "revoke" && <RevokeFields connector={editor.connector} />}
              {editor.kind === "mapping" && <MappingFields connectors={connectors} initialConnectorId={editor.connectorId} />}
              {editor.kind === "run" && <RunFields connectors={connectors} mappings={mappings} initialConnectorId={editor.connectorId} />}
              {editor.kind === "reconciliation" && <ReconciliationFields reconciliation={editor.reconciliation} />}
            </div>
            <footer className={styles.drawerFooter}>
              <button className={styles.secondaryButton} type="button" onClick={onClose} disabled={busy}>Cancelar</button>
              <button className={editor.kind === "revoke" ? styles.dangerButton : styles.primaryButton} type="submit" disabled={busy}>
                {busy ? "Processando…" : submitLabel(editor)} {!busy && <ArrowRight aria-hidden="true" />}
              </button>
            </footer>
          </form>
        )}
        {editor.kind === "detail" && <footer className={styles.drawerFooter}><button className={styles.secondaryButton} type="button" onClick={onClose}>Fechar</button></footer>}
      </div>
    </div>
  );
}

function drawerDescription(editor: NonNullable<IntegrationEditor>) {
  if (editor.kind === "credentials") return "Os campos ficam vazios e são enviados diretamente ao cofre. Nenhum segredo será exibido depois.";
  if (editor.kind === "mapping") return "Defina campos e transformações permitidas sem código arbitrário ou editor JSON.";
  if (editor.kind === "reconciliation") return "A decisão será auditada e exige uma justificativa objetiva.";
  if (editor.kind === "detail") return "Itens, tentativas e erros seguros, sem payload bruto do provedor.";
  if (editor.kind === "run") return "Uma chave de idempotência nova protegerá esta solicitação contra duplicidade.";
  if (editor.kind === "revoke") return "A credencial ativa será inutilizada e o conector voltará a aguardar autenticação.";
  return "A configuração não altera o estado para conectado; somente uma verificação real pode fazer isso.";
}

function submitLabel(editor: NonNullable<IntegrationEditor>) {
  if (editor.kind === "configure") return "Salvar configuração";
  if (editor.kind === "credentials") return editor.connector.hasCredentials ? "Rotacionar credencial" : "Guardar credencial";
  if (editor.kind === "revoke") return "Confirmar revogação";
  if (editor.kind === "mapping") return "Criar rascunho";
  if (editor.kind === "run") return "Enfileirar execução";
  return "Registrar resolução";
}

function ConfigureFields({ connector }: { connector: Connector }) {
  return <>
    <ContextStrip icon={Cable} label="CONECTOR" value={`${connector.displayName} · ${connector.channel}`} />
    <section className={styles.formSection}><header><strong>Identificação e operação</strong><span>Salvar configurações nunca comprova uma conexão.</span></header><div className={styles.formGrid}>
      <label className={styles.fieldWide}><span>Nome de exibição</span><input name="displayName" defaultValue={connector.displayName} maxLength={120} required /></label>
      {connector.channel !== "solides" && <label className={styles.fieldWide}><span>Endpoint oficial</span><input name="endpoint" type="url" inputMode="url" placeholder="https://api.fornecedor.com/v1/recurso" required /></label>}
      {connector.channel === "solides" && <label className={styles.fieldWide}><span>Referência da conta</span><input name="accountReference" maxLength={160} placeholder="Referência administrativa, sem endpoint especulativo" /></label>}
      <label><span>Estado operacional</span><select name="status" defaultValue={connector.status === "paused" ? "paused" : "needs_credentials"}><option value="needs_credentials">Aguardando verificação</option><option value="paused">Pausado</option></select></label>
    </div></section>
    {connector.channel === "solides" && <SolidesNotice />}
  </>;
}

function CredentialFields({ connector }: { connector: Connector }) {
  const fields = credentialFields[connector.channel];
  return <>
    <ContextStrip icon={Vault} label="COFRE" value={`${connector.displayName} · ${connector.hasCredentials ? `chave v${connector.keyVersion}` : "sem credencial"}`} />
    <aside className={styles.securityNotice}><KeyRound aria-hidden="true" /><div><strong>Entrada protegida</strong><span>Nenhum valor é pré-preenchido, pré-visualizado ou mantido após fechar este painel.</span></div></aside>
    <section className={styles.formSection}><header><strong>Credenciais do provedor</strong><span>Informe o conjunto emitido pelo canal oficial.</span></header><div className={styles.formGrid}>
      {fields.map((field, index) => <label className={styles.fieldWide} key={field.name}><span>{field.label}</span><input name={field.name} type="password" autoComplete="new-password" minLength={8} maxLength={16000} required={index === 0} /></label>)}
    </div></section>
    {connector.channel === "solides" && <SolidesNotice />}
  </>;
}

function RevokeFields({ connector }: { connector: Connector }) {
  return <div className={styles.confirmBlock}><AlertTriangle aria-hidden="true" /><strong>Revogar a credencial de {connector.displayName}?</strong><p>Execuções futuras serão bloqueadas até uma nova credencial ser guardada e verificada. A ação fica registrada na auditoria.</p><label className={styles.confirmCheck}><input type="checkbox" required /> Confirmo a revogação da chave v{connector.keyVersion}</label></div>;
}

function MappingFields({ connectors, initialConnectorId }: { connectors: Connector[]; initialConnectorId?: string }) {
  const [rows, setRows] = useState([0]);
  return <>
    <section className={styles.formSection}><header><strong>Escopo do mapeamento</strong><span>Cada publicação cria uma versão rastreável.</span></header><div className={styles.formGrid}>
      <label className={styles.fieldWide}><span>Conector</span><select name="integrationId" defaultValue={initialConnectorId} required><option value="">Selecione</option>{connectors.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <label><span>Recurso</span><select name="resourceType" defaultValue="employees"><option value="inbox">Inbox</option><option value="employees">Colaboradores</option><option value="hr_metrics">Indicadores de RH</option><option value="files">Arquivos</option></select></label>
      <label><span>Direção</span><select name="direction" defaultValue="inbound"><option value="inbound">Entrada</option><option value="outbound">Saída</option><option value="bidirectional">Bidirecional</option></select></label>
      <label className={styles.fieldWide}><span>Identificador externo</span><input name="externalIdField" defaultValue="id" pattern="[A-Za-z][A-Za-z0-9_.-]{0,79}" required /></label>
    </div></section>
    <section className={styles.mappingBuilder}><header><div><GitCompareArrows aria-hidden="true" /><span><strong>Campos estruturados</strong><small>Origem → transformação → destino</small></span></div><button type="button" onClick={() => setRows((current) => [...current, Math.max(...current) + 1])}><Plus aria-hidden="true" /> Adicionar campo</button></header>
      <div className={styles.mappingRows}>{rows.map((row, index) => <div className={styles.mappingRow} key={row}>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <label><span>Origem</span><input name="source" pattern="[A-Za-z][A-Za-z0-9_.-]{0,79}" required /></label>
        <label><span>Transformação</span><select name="transform" defaultValue="identity"><option value="identity">Sem alteração</option><option value="trim">Remover espaços</option><option value="uppercase">Maiúsculas</option><option value="lowercase">Minúsculas</option><option value="date">Data</option><option value="number">Número</option><option value="integer">Inteiro</option><option value="boolean">Booleano</option></select></label>
        <label><span>Destino</span><input name="target" pattern="[A-Za-z][A-Za-z0-9_.-]{0,79}" required /></label>
        <label><span>Regra</span><select name="required" defaultValue="false"><option value="false">Opcional</option><option value="true">Obrigatório</option></select></label>
        <button type="button" onClick={() => setRows((current) => current.filter((item) => item !== row))} disabled={rows.length === 1} aria-label={`Remover campo ${index + 1}`}><Trash2 aria-hidden="true" /></button>
      </div>)}</div>
    </section>
  </>;
}

function RunFields({ connectors, mappings, initialConnectorId }: { connectors: Connector[]; mappings: Mapping[]; initialConnectorId?: string }) {
  const eligible = connectors.filter((connector) => connector.status === "connected" && mappings.some((mapping) => mapping.integrationId === connector.id && mapping.status === "active"));
  const [connectorId, setConnectorId] = useState(initialConnectorId && eligible.some((item) => item.id === initialConnectorId) ? initialConnectorId : eligible[0]?.id ?? "");
  const activeMappings = mappings.filter((mapping) => mapping.integrationId === connectorId && mapping.status === "active");
  return <>
    <ContextStrip icon={ListRestart} label="EXECUÇÃO" value="Disparo manual com idempotência" />
    {eligible.length ? <section className={styles.formSection}><header><strong>Fila de sincronização</strong><span>Somente conectores com mapeamento ativo estão disponíveis.</span></header><div className={styles.formGrid}>
      <label className={styles.fieldWide}><span>Conector</span><select name="integrationId" value={connectorId} onChange={(event) => setConnectorId(event.target.value)} required>{eligible.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <label className={styles.fieldWide}><span>Mapeamento ativo</span><select name="mappingId" required>{activeMappings.map((item) => <option key={item.id} value={item.id}>{item.resourceType} · {item.direction} · v{item.version}</option>)}</select></label>
    </div></section> : <div className={styles.inlineEmpty}><AlertTriangle aria-hidden="true" /><strong>Nenhum mapeamento ativo</strong><span>Publique um mapeamento antes de solicitar uma execução.</span></div>}
  </>;
}

function ReconciliationFields({ reconciliation }: { reconciliation: NonNullable<IntegrationEditor & { kind: "reconciliation" }>["reconciliation"] }) {
  const [resolution, setResolution] = useState("link");
  return <>
    <ContextStrip icon={GitCompareArrows} label="CONFLITO" value={`${reconciliation.displayName} · ${reconciliation.entityType}`} />
    <div className={styles.safeDifference}><strong>Campos divergentes</strong><span>{reconciliation.differenceFields.length ? reconciliation.differenceFields.join(" · ") : "Metadados sem campo nominal"}</span><small>Valores externos e payloads não são exibidos.</small></div>
    <fieldset className={styles.resolutionOptions}><legend>Resolução</legend>
      {[{ value: "link", label: "Vincular", text: "Associar a um registro interno" }, { value: "accept_external", label: "Aceitar externo", text: "Manter o dado recebido" }, { value: "keep_internal", label: "Manter interno", text: "Preservar o dado atual" }, { value: "ignore", label: "Ignorar", text: "Encerrar sem vínculo" }].map((item) => <label key={item.value}><input type="radio" name="resolution" value={item.value} checked={resolution === item.value} onChange={() => setResolution(item.value)} /><span><strong>{item.label}</strong><small>{item.text}</small></span></label>)}
    </fieldset>
    <div className={styles.formGrid}>{resolution === "link" && <label className={styles.fieldWide}><span>ID do registro interno</span><input name="internalId" maxLength={160} required /></label>}<label className={styles.fieldWide}><span>Justificativa obrigatória</span><textarea name="note" rows={4} maxLength={500} required /></label></div>
  </>;
}

function RunDetailPanel({ detail, loading, error }: { detail: RunDetail | null; loading: boolean; error: string }) {
  if (loading) return <div className={styles.drawerLoading}><LoaderCircle className={styles.spin} aria-hidden="true" /><strong>Carregando execução</strong><span>Consultando itens e tentativas seguras…</span></div>;
  if (error) return <div className={styles.inlineEmpty}><AlertTriangle aria-hidden="true" /><strong>Não foi possível carregar</strong><span>{error}</span></div>;
  if (!detail) return null;
  return <div className={styles.detailBody}>
    <div className={styles.detailSummary}><StatusMark status={detail.run.status} /><div><span>EXECUÇÃO · {detail.run.channel?.toUpperCase()}</span><strong>{detail.run.displayName}</strong><small>{detail.run.resourceType} · {detail.run.direction} · mapeamento v{detail.run.mappingVersion}</small></div><b>TENTATIVA {detail.run.attempt}</b></div>
    <section className={styles.detailSection}><header><strong>Jobs da fila</strong><span>{detail.jobs.length} registro(s)</span></header>{detail.jobs.length ? detail.jobs.map((job) => <article key={job.id}><CircleDot aria-hidden="true" /><div><strong>{job.jobType}</strong><span>{job.lastErrorCode ? `${job.lastErrorCode} · ${job.lastErrorMessage}` : `Disponível em ${formatDate(job.availableAt)}`}</span></div><StatusMark status={job.status} /><b>{job.attempt}/{job.maxAttempts}</b></article>) : <p>Nenhum job associado.</p>}</section>
    <section className={styles.detailSection}><header><strong>Itens processados</strong><span>{detail.items.length} registro(s), sem payload bruto</span></header>{detail.items.length ? detail.items.map((item, index) => <article key={item.id}><span className={styles.itemIndex}>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.targetType || "Item externo"}</strong><span>{item.errorCode ? `${item.errorCode} · ${item.errorMessage}` : item.metadataFields.length ? `Metadados: ${item.metadataFields.join(", ")}` : "Sem metadados públicos"}</span></div><StatusMark status={item.status} /><time>{formatDate(item.processedAt || item.createdAt)}</time></article>) : <p>Nenhum item processado até agora.</p>}</section>
  </div>;
}

function ContextStrip({ icon: Icon, label, value }: { icon: typeof Cable; label: string; value: string }) {
  return <div className={styles.contextStrip}><Icon aria-hidden="true" /><span><small>{label}</small><strong>{value}</strong></span></div>;
}

function SolidesNotice() {
  return <aside className={styles.solidesNotice}><AlertTriangle aria-hidden="true" /><div><strong>Fronteira Sólides</strong><span>Permanece aguardando credenciais até existir recurso oficial confirmado e autenticação real bem-sucedida. O Vinculato não realiza admissão digital.</span></div></aside>;
}

function StatusMark({ status }: { status: string }) {
  const tone = ["connected", "completed", "processed", "succeeded"].includes(status) ? "safe" : ["failed", "dead_letter", "conflict"].includes(status) ? "danger" : "warning";
  return <span className={styles.statusPill} data-tone={tone}><CircleDot aria-hidden="true" />{status.replaceAll("_", " ")}</span>;
}
