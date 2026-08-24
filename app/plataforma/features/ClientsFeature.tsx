"use client";

import { FormEvent, useState } from "react";
import { AlertTriangle, Archive, Ban, Building2, CheckCircle2, ChevronRight, Plus, Search, Settings2, Trash2, UserRoundCheck } from "lucide-react";
import styles from "../platform.module.css";
import { AdminAction, AdminActionDialog, Empty, ErrorState, FeatureHeader, FeatureProps, Loading, Notice, Panel, Row, Status, date, number, platformRequest, text, usePlatformResource } from "./core";

/** Estados em que a exclusão definitiva é aceita pelo servidor. */
const DELETABLE = new Set(["archived", "canceled"]);

type DeletionResult = { deleted: { workspaceName: string; rows: number; tables: number; orphanUsers: number } };

/**
 * A ação de excluir vive aqui, e não dentro de um dos dois lugares que a usam,
 * porque a listagem e o painel de detalhe precisam abrir exatamente a mesma
 * confirmação. Duas cópias divergiriam na primeira vez que alguém ajustasse o
 * texto de impacto — e é justamente o texto de impacto que segura o clique.
 */
function deleteWorkspaceAction(
  workspace: { id: string; name: string; slug: string },
  onDeleted: (summary: string) => void,
): AdminAction {
  return {
    title: `Excluir definitivamente ${workspace.name}`,
    consequence: "Esta operação é irreversível. Todos os dados do grupo, a trilha de auditoria dele e as identidades que só existiam aqui serão removidos. Sobra apenas o registro da exclusão, com a contagem por tabela feita antes de apagar.",
    confirmLabel: "Excluir definitivamente",
    reasonMinLength: 10,
    typedConfirmation: text(workspace.slug),
    run: async ({ reason, confirmation }) => {
      const payload = await platformRequest<DeletionResult>(
        `/api/platform/workspaces/${encodeURIComponent(workspace.id)}/delete`,
        { method: "POST", body: JSON.stringify({ reason, confirmation, confirmed: true }) },
      );
      // O servidor conta antes de apagar; repetir o número aqui é o que
      // transforma "excluído" em algo que a pessoa consegue conferir depois.
      const { rows, tables, orphanUsers } = payload.deleted;
      onDeleted(
        `${workspace.name} foi excluído: ${rows} registro(s) em ${tables} tabela(s)`
        + `${orphanUsers > 0 ? ` e ${orphanUsers} identidade(s) sem outro vínculo` : ""}.`
        + " O registro da exclusão permanece na auditoria global.",
      );
    },
  };
}

export function ClientsFeature({ params, updateQuery }: FeatureProps) {
  const query = params.get("q") ?? ""; const status = params.get("status") ?? ""; const cursor = params.get("cursor") ?? ""; const selected = params.get("workspace") ?? "";
  const [action, setAction] = useState<AdminAction | null>(null); const [notice, setNotice] = useState(""); const [creating, setCreating] = useState(false);
  const url = `/api/platform/workspaces?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: "30" })}`;
  const resource = usePlatformResource<{ workspaces: Row[]; nextCursor?: string }>(url);
  const overview = usePlatformResource<{ plans: Row[] }>("/api/platform/overview");
  const plans = overview.data?.plans ?? [];
  const refresh = () => { resource.refresh(); overview.refresh(); };
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const value = String(new FormData(event.currentTarget).get("q") ?? "").trim(); updateQuery({ q: value || null, cursor: null }); }
  function statusAction(row: Row) { const next = text(row.status) === "active" ? "suspended" : "active"; const name = text(row.name); setAction({ title: `${next === "active" ? "Reativar" : "Suspender"} ${name}`, consequence: next === "active" ? "O workspace voltará a aceitar acesso e operação conforme o plano contratado." : "O acesso ao workspace será interrompido para todos os membros até uma reativação explícita. Os dados serão preservados.", confirmLabel: next === "active" ? "Reativar workspace" : "Suspender workspace", run: async ({ reason }) => { await platformRequest(`/api/platform/workspaces/${encodeURIComponent(text(row.id))}`, { method: "PATCH", body: JSON.stringify({ status: next, reason, confirmed: true }) }); setNotice(`Workspace ${name} ${next === "active" ? "reativado" : "suspenso"}.`); refresh(); } }); }
  return <><FeatureHeader eyebrow="CADASTRO E CONTRATO" title="Clientes" description="Workspaces, proprietários, plano, capacidade, configuração e ciclo de vida." loading={resource.loading} onRefresh={refresh} actions={<button type="button" className={styles.headerAction} onClick={() => setCreating(true)}><Plus aria-hidden="true" />Novo workspace</button>} />
    {notice && <Notice>{notice}</Notice>}
    <form key={query} className={styles.filterBar} onSubmit={search}><label><Search aria-hidden="true" /><input name="q" defaultValue={query} placeholder="Nome, slug ou CNPJ" aria-label="Buscar clientes" /></label><select value={status} onChange={(event) => updateQuery({ status: event.target.value || null, cursor: null })} aria-label="Filtrar situação"><option value="">Todos os status</option><option value="active">Ativos</option><option value="suspended">Suspensos</option><option value="canceled">Cancelados</option><option value="archived">Arquivados</option></select><button type="submit">Buscar</button></form>
    {resource.loading && !resource.data ? <Loading /> : resource.error ? <ErrorState message={resource.error} retry={refresh} /> : <Panel title="Workspaces" subtitle="Lista paginada por cursor, ordenada por criação."><div className={styles.tableWrap}><table><thead><tr><th>Cliente</th><th>Proprietário</th><th>Plano</th><th>Uso</th><th>Status</th><th>Ações</th></tr></thead><tbody>{(resource.data?.workspaces ?? []).map((row) => <tr key={text(row.id)}><td><button className={styles.rowLink} onClick={() => updateQuery({ workspace: text(row.id) })}><Building2 aria-hidden="true" /><span><strong>{text(row.name)}</strong><small>{text(row.slug)}</small></span><ChevronRight aria-hidden="true" /></button></td><td><strong>{text(row.owner_name)}</strong><small>{text(row.owner_email)}</small></td><td><strong>{text(row.plan_name) || "Sem plano"}</strong><small>{text(row.subscription_status)}</small></td><td>{number(row.seats_used)}/{Math.max(number(row.seat_quantity), number(row.included_seats))} assentos<br />{number(row.companies)} empresas</td><td><Status value={text(row.status) || "active"} /></td><td><div className={styles.rowActions}><button className={styles.smallAction} onClick={() => statusAction(row)}>{text(row.status) === "active" ? <Ban aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}{text(row.status) === "active" ? "Suspender" : "Reativar"}</button>
      {/* Só para grupo já fora de operação: é a mesma porta que o servidor
          exige, trazida para a listagem para que a opção seja encontrável sem
          precisar abrir o detalhe e descobrir por tentativa. */}
      {DELETABLE.has(text(row.status)) && <button className={`${styles.smallAction} ${styles.dangerAction}`} onClick={() => setAction(deleteWorkspaceAction({ id: text(row.id), name: text(row.name), slug: text(row.slug) }, (summary) => { setNotice(summary); updateQuery({ workspace: null }); refresh(); }))}><Trash2 aria-hidden="true" />Excluir</button>}</div></td></tr>)}</tbody></table></div>{!(resource.data?.workspaces?.length) && <Empty />}
      <div className={styles.pagination}><button type="button" disabled={!cursor} onClick={() => updateQuery({ cursor: null })}>Primeira página</button><button type="button" disabled={!resource.data?.nextCursor} onClick={() => updateQuery({ cursor: resource.data?.nextCursor ?? null })}>Próxima página</button></div></Panel>}
    <Panel title="Catálogo de planos" subtitle="Capacidade e preços publicados; identificadores de provedor são públicos."><div className={styles.cardGrid}>{plans.map((plan) => <article key={text(plan.id)}><header><strong>{text(plan.name)}</strong><Status value={text(plan.status)} /></header><p>{text(plan.description)}</p><dl><div><dt>Mensal</dt><dd>{number(plan.monthlyPriceCents) / 100} BRL</dd></div><div><dt>Assentos</dt><dd>{number(plan.includedSeats)}</dd></div><div><dt>Integrações</dt><dd>{number(plan.integrationLimit)}</dd></div></dl></article>)}</div></Panel>
    {selected && <WorkspaceDetail id={selected} plans={plans} onClose={() => updateQuery({ workspace: null })} onConfigure={() => updateQuery({ area: "operations", workspace: selected })} onChanged={() => { setNotice("Workspace atualizado e evento de auditoria registrado."); refresh(); }} onDeleted={(summary) => { setNotice(summary); updateQuery({ workspace: null }); refresh(); }} />}
    {creating && <CreateWorkspaceDialog plans={plans} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setNotice("Workspace, proprietário, assinatura e padrões criados em uma transação."); refresh(); updateQuery({ workspace: id }); }} />}
    <AdminActionDialog action={action} onClose={() => setAction(null)} />
  </>;
}

function WorkspaceDetail({ id, plans, onClose, onConfigure, onChanged, onDeleted }: { id: string; plans: Row[]; onClose: () => void; onConfigure: () => void; onChanged: () => void; onDeleted: (summary: string) => void }) {
  const resource = usePlatformResource<Row>(`/api/platform/workspaces/${encodeURIComponent(id)}/detail`); const [action, setAction] = useState<AdminAction | null>(null); const [planCode, setPlanCode] = useState("");
  const workspace = (resource.data?.workspace ?? {}) as Row; const plan = (workspace.plan ?? {}) as Row; const owner = (workspace.owner ?? {}) as Row; const subscription = (workspace.subscription ?? {}) as Row;
  const mutate = (title: string, consequence: string, body: Row, confirmLabel: string, options: Partial<AdminAction> = {}) => setAction({ title, consequence, confirmLabel, ...options, run: async ({ reason, confirmation, value }) => { const payload = { ...body, reason, confirmed: true, ...(confirmation ? { confirmation } : {}), ...(value ? { ownerEmail: value } : {}) }; await platformRequest(`/api/platform/workspaces/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }); resource.refresh(); onChanged(); } });
  const currentPlan = planCode || text(plan.code);
  const status = text(workspace.status);
  const canPurge = ["archived", "canceled"].includes(status);
  return <><div className={styles.detailOverlay}><aside className={styles.detailPane} role="dialog" aria-modal="true" aria-labelledby="workspace-detail"><header><div><span>CLIENTE</span><h2 id="workspace-detail">{text(workspace.name) || "Carregando…"}</h2></div><button onClick={onClose}>Fechar</button></header>{resource.loading ? <Loading /> : resource.error ? <ErrorState message={resource.error} retry={resource.refresh} /> : <div className={styles.detailBody}>
    <dl className={styles.detailGrid}><div><dt>Status</dt><dd><Status value={status} /></dd></div><div><dt>Slug</dt><dd>{text(workspace.slug)}</dd></div><div><dt>Proprietário</dt><dd>{text(owner.name)}<small>{text(owner.email)}</small></dd></div><div><dt>Plano</dt><dd>{text(plan.name)}</dd></div><div><dt>Assinatura</dt><dd>{text(subscription.status)}<small>{text(subscription.provider)}</small></dd></div><div><dt>Criado</dt><dd>{date(workspace.createdAt)}</dd></div><div><dt>Razão social</dt><dd>{text(workspace.legalName) || "—"}<small>{text(workspace.taxId) || "Sem CNPJ"}</small></dd></div><div><dt>Contato</dt><dd>{text(workspace.contactEmail) || "—"}</dd></div></dl>
    <section className={styles.detailActions}><h3><Settings2 aria-hidden="true" />Configuração operacional</h3><p>Administre empresas, fluxo, campos, templates, SLA, automações, acessos, módulos, chaves e webhooks no contexto deste cliente.</p><button type="button" className={styles.smallAction} onClick={onConfigure}><Settings2 aria-hidden="true" />Administrar configuração</button></section>
    <section className={styles.detailActions}><h3>Plano e limites</h3><p>O servidor recusa downgrade abaixo do consumo atual e cria trilha antes/depois.</p><div className={styles.rowActions}><select value={currentPlan} onChange={(event) => setPlanCode(event.target.value)} aria-label="Novo plano">{plans.map((item) => <option key={text(item.code)} value={text(item.code)}>{text(item.name)}</option>)}</select><button type="button" disabled={!currentPlan || currentPlan === text(plan.code)} onClick={() => mutate(`Alterar plano de ${text(workspace.name)}`, "A assinatura passará a usar os limites e o preço publicado do plano selecionado. Nenhum usuário será removido automaticamente.", { planCode: currentPlan }, "Aplicar plano")}>Aplicar plano</button></div></section>
    <section className={styles.detailActions}><h3><UserRoundCheck aria-hidden="true" />Propriedade</h3><p>O novo proprietário precisa ter uma identidade ativa e receberá papel administrativo neste workspace.</p><button type="button" className={styles.smallAction} onClick={() => mutate(`Transferir ${text(workspace.name)}`, "A propriedade do cliente e a responsabilidade administrativa serão transferidas. O proprietário anterior não é removido automaticamente.", {}, "Transferir propriedade", { extraInput: { label: "E-mail do novo proprietário", type: "email", placeholder: "pessoa@empresa.com" } })}>Transferir propriedade</button></section>
    <section className={styles.detailActions}><h3>Ciclo de vida</h3><p>Suspender, cancelar e arquivar preservam os dados. Exclusão definitiva fica separada e nunca é automática.</p><div className={styles.rowActions}>{["active", "suspended", "canceled", "archived"].filter((next) => next !== status).map((next) => <button type="button" key={next} data-danger={next === "active" ? undefined : "true"} onClick={() => mutate(`${next === "active" ? "Reativar" : next === "suspended" ? "Suspender" : next === "canceled" ? "Cancelar" : "Arquivar"} ${text(workspace.name)}`, next === "active" ? "O acesso e a operação voltarão a ser permitidos." : "O estado do cliente mudará, mas dados, auditoria e histórico serão preservados.", { status: next }, "Confirmar alteração")}>{next}</button>)}</div></section>
    {/*
      A zona de risco fica sempre visível. Antes ela só existia depois que o
      grupo já estava arquivado ou cancelado — quem procurava "excluir workspace"
      num grupo ativo não achava nada e não tinha como saber que faltava
      arquivar primeiro. A porta continua a mesma; o que mudou é que ela agora
      é visível e diz o que falta para ser aberta.
    */}
    <section className={`${styles.detailActions} ${styles.dangerZone}`}>
      <strong>Exclusão definitiva do workspace</strong>
      <p>Remove o grupo e tudo que pertence a ele. Antes de apagar, o servidor conta as linhas de cada tabela e grava esse número no registro de exclusão — é o que permite conferir a operação depois, quando o dado que serviria de prova já não existe.</p>
      <ul>
        <li>Empresas, demandas, documentos, integrações e a trilha de auditoria do grupo são removidos.</li>
        <li>Identidades que só tinham vínculo com este grupo também saem; quem participa de outro grupo permanece.</li>
        <li>Não há desfazer. Só o registro da exclusão, com motivo e responsável, permanece.</li>
      </ul>
      {canPurge
        ? <button type="button" onClick={() => setAction(deleteWorkspaceAction({ id, name: text(workspace.name), slug: text(workspace.slug) }, (summary) => { onDeleted(summary); onClose(); }))}><Trash2 aria-hidden="true" />Excluir definitivamente</button>
        : <><p className={styles.dangerGate}><AlertTriangle aria-hidden="true" /><span>Arquive ou cancele o cliente antes de excluir. <strong>{text(workspace.name)}</strong> está {status === "active" ? "ativo" : "suspenso"}; tirar o grupo de operação interrompe o acesso sem perder dados.</span></p>
          <div className={styles.rowActions}>
            <button type="button" disabled={!canPurge} title="Arquive ou cancele o grupo antes de excluir"><Trash2 aria-hidden="true" />Excluir definitivamente</button>
            <button type="button" data-danger="true" onClick={() => mutate(`Arquivar ${text(workspace.name)}`, "O acesso ao grupo é interrompido para todos os membros. Dados, auditoria e histórico continuam preservados, e o grupo passa a poder ser excluído definitivamente.", { status: "archived" }, "Arquivar workspace")}><Archive aria-hidden="true" />Arquivar agora</button>
          </div></>}
    </section>
    <DetailRows title="Membros" rows={resource.data?.members} /><DetailRows title="Empresas" rows={resource.data?.companies} /><DetailRows title="Módulos" rows={resource.data?.modules} /><DetailRows title="Auditoria" rows={resource.data?.audit} />
  </div>}</aside></div><AdminActionDialog action={action} onClose={() => setAction(null)} /></>;
}

function DetailRows({ title, rows }: { title: string; rows: unknown }) {
  const list = Array.isArray(rows) ? rows as Row[] : [];
  return (
    <section className={styles.detailSection}>
      <h3>{title}</h3>
      {list.length
        ? list.slice(0, 20).map((row, index) => (
          <article key={text(row.id ?? row.userId ?? row.key) || index}>
            <strong>{text(row.name ?? row.email ?? row.legalName ?? row.action ?? row.key)}</strong>
            <small>{text(row.role ?? row.status ?? row.category ?? row.createdAt)}</small>
          </article>
        ))
        : <Empty />}
    </section>
  );
}

function CreateWorkspaceDialog({ plans, onClose, onCreated }: { plans: Row[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(""); try { const data = new FormData(event.currentTarget); const field = (name: string) => String(data.get(name) ?? "").trim(); const payload = await platformRequest<{ workspace: { id: string } }>("/api/platform/workspaces", { method: "POST", body: JSON.stringify({ name: field("name"), slug: field("slug"), planCode: field("planCode"), legalName: field("legalName"), taxId: field("taxId"), contactEmail: field("contactEmail"), ownerName: field("ownerName"), ownerEmail: field("ownerEmail"), reason: field("reason"), confirmed: data.get("confirmed") === "on" }) }); onCreated(payload.workspace.id); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao criar workspace."); } finally { setBusy(false); } }
  return <div className={styles.dialogBackdrop}><form className={`${styles.actionDialog} ${styles.wideDialog}`} role="dialog" aria-modal="true" aria-labelledby="create-workspace" onSubmit={submit}><header><div><span>PROVISIONAMENTO TRANSACIONAL</span><h2 id="create-workspace">Novo workspace</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label="Fechar">×</button></header><div className={styles.formGrid}><label>Nome do workspace<input name="name" required minLength={2} maxLength={120} autoFocus /></label><label>Slug opcional<input name="slug" maxLength={60} /></label><label>Plano<select name="planCode" defaultValue={text(plans[0]?.code) || "starter"}>{plans.map((plan) => <option key={text(plan.code)} value={text(plan.code)}>{text(plan.name)}</option>)}</select></label><label>Razão social<input name="legalName" maxLength={200} /></label><label>CNPJ<input name="taxId" maxLength={20} /></label><label>Contato do grupo<input name="contactEmail" type="email" maxLength={180} /></label><label>Nome do proprietário<input name="ownerName" maxLength={160} /></label><label>E-mail do proprietário<input name="ownerEmail" type="email" required maxLength={180} /></label><label className={styles.fullField}>Motivo do provisionamento<textarea name="reason" required minLength={5} rows={3} /></label><label className={`${styles.fullField} ${styles.confirmCheck}`}><input name="confirmed" type="checkbox" required />Confirmo a criação do cliente, proprietário, assinatura e configuração inicial.</label>{error && <p className={`${styles.dialogError} ${styles.fullField}`} role="alert">{error}</p>}</div><footer><button type="button" onClick={onClose} disabled={busy}>Cancelar</button><button type="submit" disabled={busy}>{busy ? "Criando…" : "Criar workspace"}</button></footer></form></div>;
}
