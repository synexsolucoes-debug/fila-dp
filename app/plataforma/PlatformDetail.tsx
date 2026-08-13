"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Building2, CheckCircle2, KeyRound, Link2, RefreshCw, ShieldCheck, Trash2, Users } from "lucide-react";
import styles from "./platform.module.css";

/**
 * Detalhe administrativo de um workspace ou de uma identidade.
 *
 * O console listava e pouco mais: dava para suspender e arquivar, mas não para
 * abrir um cliente e ver quem está lá dentro, qual plano paga, quais módulos
 * tem e o que já foi feito. Sem isso, administrar era decidir no escuro.
 *
 * As ações reaproveitam as rotas que já existiam — todas com autorização de
 * plataforma no servidor e trilha de auditoria. Nada aqui confia na interface.
 */

type Tab = "overview" | "members" | "companies" | "modules" | "audit";

type DeletionReceipt = {
  workspaceName: string; tables: number; rows: number; orphanUsers: number;
};

/**
 * Confirmação de exclusão definitiva.
 *
 * As quatro travas que o servidor exige aparecem aqui como quatro coisas que a
 * pessoa vê — não porque a tela decida algo (ela não decide: quem recusa é o
 * servidor), mas porque uma confirmação que esconde o que vai acontecer não é
 * confirmação, é armadilha.
 *
 * O identificador digitado por extenso é a trava que mais importa: ela impede
 * que um clique caia no grupo errado, que é o erro que ninguém desfaz.
 */
function DeleteWorkspaceDialog({ workspace, onCancel, onDeleted }: {
  workspace: { id: string; name: string; slug: string; status: string };
  onCancel: () => void;
  onDeleted: (receipt: DeletionReceipt) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const slugOk = confirmation.trim() === workspace.slug;
  const reasonOk = reason.trim().length >= 10;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = await call<{ deleted: DeletionReceipt }>(`/api/platform/workspaces/${workspace.id}/delete`, {
        method: "POST",
        body: JSON.stringify({ confirmation: confirmation.trim(), reason: reason.trim() }),
      });
      onDeleted(payload.deleted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível excluir o grupo.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.confirmBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <form className={styles.confirmDialog} role="dialog" aria-modal="true"
        aria-labelledby="excluir-grupo" onSubmit={submit}>
        <header>
          <span className={styles.confirmMark} aria-hidden="true"><Trash2 /></span>
          <div>
            <h3 id="excluir-grupo">Excluir {workspace.name} definitivamente</h3>
            <p>Isto não é arquivar. Os dados, o histórico e a trilha de auditoria deste grupo
              são apagados e <b>não há como recuperar</b>.</p>
          </div>
        </header>

        <p className={styles.confirmLedger}>
          Antes de apagar, o sistema conta cada tabela e guarda o número num registro permanente,
          com o motivo e quem executou. É a única coisa que sobra depois.
        </p>

        <label>
          <span>Digite o identificador do grupo para confirmar: <code>{workspace.slug}</code></span>
          <input ref={inputRef} value={confirmation} disabled={busy} autoComplete="off" spellCheck={false}
            aria-invalid={confirmation.length > 0 && !slugOk}
            onChange={(event) => setConfirmation(event.target.value)} />
        </label>

        <label>
          <span>Motivo da exclusão (mínimo 10 caracteres)</span>
          <textarea rows={3} value={reason} disabled={busy}
            aria-invalid={reason.length > 0 && !reasonOk}
            onChange={(event) => setReason(event.target.value)} />
        </label>

        {error && <p className={styles.confirmError} role="alert">{error}</p>}

        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="submit" data-danger="true" disabled={busy || !slugOk || !reasonOk}>
            {busy ? "Excluindo…" : "Excluir definitivamente"}
          </button>
        </footer>
      </form>
    </div>
  );
}

const roleLabels: Record<string, string> = {
  admin: "Administrador", member: "Membro", observer: "Observador", guest: "Convidado",
};
const workspaceStatusLabels: Record<string, string> = {
  active: "Ativo", suspended: "Suspenso", canceled: "Cancelado", archived: "Arquivado",
};

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; requestId?: string };
  if (!response.ok) {
    throw new Error(payload.error
      ? `${payload.error}${payload.requestId ? ` (chamado ${payload.requestId})` : ""}`
      : "Não foi possível concluir a operação.");
  }
  return payload;
}

type WorkspaceDetail = {
  workspace: Record<string, never> & {
    id: string; name: string; slug: string; status: string; statusReason: string; legalName: string; taxId: string;
    contactEmail: string; createdAt: string;
    owner: { id: string; email: string; name: string };
    subscription: { status: string; seatQuantity: number; provider: string; contractedMonthlyPriceCents: number; trialEndsAt: string | null; currentPeriodEnd: string | null };
    plan: { code: string; name: string; includedSeats: number; companyLimit: number; integrationLimit: number; storageLimitMb: number };
  };
  members: Array<{ userId: string; email: string; name: string; role: string; isOwner: boolean; isActivated: boolean; status: string; lastSeenAt: string | null }>;
  companies: Array<{ id: string; legalName: string; tradeName: string; taxId: string; isPrincipal: boolean; status: string }>;
  modules: Array<{ key: string; name: string; category: string; inPlan: boolean; grantedOverride: boolean }>;
  audit: Array<{ id: string; actorEmail: string; action: string; createdAt: string; after: string }>;
};

type UserDetail = {
  user: { id: string; email: string; name: string; status: string; statusReason: string; createdAt: string; isActivated: boolean };
  memberships: Array<{ workspaceId: string; workspaceName: string; workspaceStatus: string; role: string; joinedAt: string; isOwner: boolean }>;
  sessions: Array<{ id: string; deviceLabel: string; createdAt: string; lastSeenAt: string; expiresAt: string }>;
  audit: Array<{ id: string; actorEmail: string; action: string; createdAt: string; after: string }>;
};

export function WorkspaceDetailDrawer({ id, plans, onClose, onChanged }: {
  id: string; plans: Array<{ code: string; name: string }>; onClose: () => void; onChanged: () => void;
}) {
  const [data, setData] = useState<WorkspaceDetail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);

  const load = useCallback(async () => {
    try { setData(await call<WorkspaceDetail>(`/api/platform/workspaces/${id}/detail`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar o workspace."); }
  }, [id]);

  useEffect(() => {
    let active = true;
    void call<WorkspaceDetail>(`/api/platform/workspaces/${id}/detail`)
      .then((payload) => { if (active) setData(payload); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar o workspace."); });
    return () => { active = false; };
  }, [id]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); await load(); onChanged(); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação."); }
    finally { setBusy(false); }
  }

  const workspace = data?.workspace;

  return (
    <div className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="detalhe-workspace">
      <header>
        <div>
          <span>WORKSPACE</span>
          <h2 id="detalhe-workspace">{workspace?.name ?? "Carregando…"}</h2>
          {workspace && <small>{workspaceStatusLabels[workspace.status] ?? workspace.status}
            {workspace.statusReason ? ` · ${workspace.statusReason}` : ""}</small>}
        </div>
        <button type="button" onClick={onClose} aria-label="Fechar">×</button>
      </header>

      {error && <p className={styles.drawerError} role="alert">{error}</p>}

      <div className={styles.detailTabs} role="tablist" aria-label="Seções do workspace">
        {([["overview", "Visão geral"], ["members", "Membros"], ["companies", "Empresas"], ["modules", "Módulos"], ["audit", "Auditoria"]] as const)
          .map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key}
              className={tab === key ? styles.activeTab : ""} onClick={() => setTab(key)}>{label}</button>
          ))}
      </div>

      <div className={styles.drawerBody}>
        {!data ? <p>Carregando…</p> : tab === "overview" ? (
          <>
            <dl className={styles.detailGrid}>
              <div><dt>Proprietário</dt><dd>{workspace!.owner.name || "—"}<small>{workspace!.owner.email}</small></dd></div>
              <div><dt>Plano</dt><dd>{workspace!.plan.name || "—"}<small>{workspace!.plan.includedSeats} assentos incluídos</small></dd></div>
              <div><dt>Assinatura</dt><dd>{workspace!.subscription.status}<small>{workspace!.subscription.provider || "sem provedor"}</small></dd></div>
              <div><dt>Valor contratado</dt><dd>{money(workspace!.subscription.contractedMonthlyPriceCents)}<small>por mês</small></dd></div>
              <div><dt>Assentos</dt><dd>{data.members.length} / {Math.max(workspace!.subscription.seatQuantity, workspace!.plan.includedSeats)}</dd></div>
              <div><dt>Empresas</dt><dd>{data.companies.length} / {workspace!.plan.companyLimit}</dd></div>
              <div><dt>Razão social</dt><dd>{workspace!.legalName || "—"}<small>{workspace!.taxId || "sem CNPJ"}</small></dd></div>
              <div><dt>Criado em</dt><dd>{when(workspace!.createdAt)}</dd></div>
            </dl>

            <section className={styles.detailActions}>
              <h3>Plano e limites</h3>
              <p>Trocar o plano recalcula limites e preço contratado. Reduzir com mais usuários que o novo limite é recusado pelo servidor.</p>
              <div>
                <label>Plano
                  <select defaultValue={workspace!.plan.code} disabled={busy}
                    onChange={(event) => {
                      const planCode = event.target.value;
                      if (planCode === workspace!.plan.code) return;
                      void run(() => call(`/api/platform/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ planCode }) }));
                    }}>
                    {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
                  </select>
                </label>
              </div>
            </section>

            <section className={styles.detailActions}>
              <h3>Ciclo de vida</h3>
              <p>Arquivar e cancelar são estados, não exclusão: os dados e o histórico permanecem.</p>
              <div className={styles.rowActions}>
                {workspace!.status !== "active" && (
                  <button type="button" disabled={busy}
                    onClick={() => void run(() => call(`/api/platform/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }))}>
                    <CheckCircle2 aria-hidden="true" /> Reativar
                  </button>
                )}
                {(["suspended", "canceled", "archived"] as const).filter((status) => status !== workspace!.status).map((status) => (
                  <button key={status} type="button" data-danger="true" disabled={busy}
                    onClick={() => {
                      const reason = window.prompt(`Motivo para ${workspaceStatusLabels[status].toLowerCase()} ${workspace!.name} (mínimo 5 caracteres):`) ?? "";
                      if (reason.trim().length < 5) return;
                      void run(() => call(`/api/platform/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ status, reason: reason.trim() }) }));
                    }}>
                    <Ban aria-hidden="true" /> {workspaceStatusLabels[status]}
                  </button>
                ))}
              </div>
            </section>

            <section className={styles.detailActions} data-tone="danger">
              <h3>Exclusão definitiva</h3>
              {receipt ? (
                <p className={styles.deleteReceipt} role="status">
                  <strong>{receipt.workspaceName} foi excluído.</strong>
                  {" "}{receipt.rows} linha(s) em {receipt.tables} tabela(s)
                  {receipt.orphanUsers > 0 ? `, incluindo ${receipt.orphanUsers} conta(s) que só existiam neste grupo` : ""}.
                  O registro permanente da exclusão ficou gravado com o motivo e o seu e-mail.
                </p>
              ) : (
                <>
                  <p>
                    Apaga os dados, o histórico e a trilha de auditoria deste grupo. Não há como recuperar.
                    {workspace!.status !== "archived" && workspace!.status !== "canceled" && (
                      <> Só é possível excluir um grupo <b>arquivado ou cancelado</b> — arquive antes.</>
                    )}
                  </p>
                  <div className={styles.rowActions}>
                    <button type="button" data-danger="true"
                      disabled={busy || (workspace!.status !== "archived" && workspace!.status !== "canceled")}
                      onClick={() => setConfirmingDelete(true)}>
                      <Trash2 aria-hidden="true" /> Excluir grupo definitivamente
                    </button>
                  </div>
                </>
              )}
            </section>
          </>
        ) : tab === "members" ? (
          <table className={styles.detailTable}>
            <thead><tr><th>Pessoa</th><th>Papel</th><th>Último acesso</th></tr></thead>
            <tbody>
              {data.members.map((member) => (
                <tr key={member.userId}>
                  <td><strong>{member.name}{member.isOwner ? " · proprietário" : ""}</strong><small>{member.email}</small>
                    {!member.isActivated && <small>ativação pendente</small>}</td>
                  <td>{roleLabels[member.role] ?? member.role}</td>
                  <td><time>{when(member.lastSeenAt)}</time></td>
                </tr>
              ))}
              {data.members.length === 0 && <tr><td colSpan={3}>Nenhum membro.</td></tr>}
            </tbody>
          </table>
        ) : tab === "companies" ? (
          <table className={styles.detailTable}>
            <thead><tr><th>Empresa</th><th>CNPJ</th><th>Situação</th></tr></thead>
            <tbody>
              {data.companies.map((company) => (
                <tr key={company.id}>
                  <td><strong>{company.tradeName || company.legalName}{company.isPrincipal ? " · principal" : ""}</strong><small>{company.legalName}</small></td>
                  <td>{company.taxId || "—"}</td>
                  <td>{company.status}</td>
                </tr>
              ))}
              {data.companies.length === 0 && <tr><td colSpan={3}>Nenhuma empresa cadastrada.</td></tr>}
            </tbody>
          </table>
        ) : tab === "modules" ? (
          <table className={styles.detailTable}>
            <thead><tr><th>Módulo</th><th>No plano</th><th>Liberação manual</th></tr></thead>
            <tbody>
              {data.modules.map((item) => (
                <tr key={item.key}>
                  <td><strong>{item.name}</strong><small>{item.category}</small></td>
                  <td>{item.inPlan ? "Sim" : "Não"}</td>
                  <td>{item.grantedOverride ? "Liberado" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className={styles.detailTable}>
            <thead><tr><th>Quando</th><th>Ação</th><th>Autor</th></tr></thead>
            <tbody>
              {data.audit.map((event) => (
                <tr key={event.id}>
                  <td><time>{when(event.createdAt)}</time></td>
                  <td><strong>{event.action}</strong><small>{event.after}</small></td>
                  <td>{event.actorEmail}</td>
                </tr>
              ))}
              {data.audit.length === 0 && <tr><td colSpan={3}>Nenhum evento registrado.</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {confirmingDelete && workspace && (
        <DeleteWorkspaceDialog
          workspace={{ id: workspace.id, name: workspace.name, slug: workspace.slug, status: workspace.status }}
          onCancel={() => setConfirmingDelete(false)}
          onDeleted={(payload) => {
            setConfirmingDelete(false);
            // O recibo fica na tela em vez de sumir junto com o grupo: o número
            // de linhas apagadas é a única prova que ainda existe.
            setReceipt(payload);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

export function UserDetailDrawer({ id, workspaces, onClose, onChanged }: {
  id: string; workspaces: Array<{ id: string; name: string }>; onClose: () => void; onChanged: () => void;
}) {
  const [data, setData] = useState<UserDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkWorkspace, setLinkWorkspace] = useState("");
  const [linkRole, setLinkRole] = useState("member");

  const load = useCallback(async () => {
    try { setData(await call<UserDetail>(`/api/platform/users/${id}/detail`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar o usuário."); }
  }, [id]);

  useEffect(() => {
    let active = true;
    void call<UserDetail>(`/api/platform/users/${id}/detail`)
      .then((payload) => { if (active) setData(payload); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar o usuário."); });
    return () => { active = false; };
  }, [id]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); await load(); onChanged(); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação."); }
    finally { setBusy(false); }
  }

  const patch = (body: Record<string, unknown>) => call(`/api/platform/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });

  return (
    <div className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="detalhe-usuario">
      <header>
        <div>
          <span>IDENTIDADE GLOBAL</span>
          <h2 id="detalhe-usuario">{data?.user.name ?? "Carregando…"}</h2>
          {data && <small>{data.user.email} · {data.user.status === "blocked" ? "bloqueado" : "ativo"}
            {data.user.isActivated ? "" : " · ativação pendente"}</small>}
        </div>
        <button type="button" onClick={onClose} aria-label="Fechar">×</button>
      </header>

      {error && <p className={styles.drawerError} role="alert">{error}</p>}

      <div className={styles.drawerBody}>
        {!data ? <p>Carregando…</p> : (
          <>
            <section className={styles.detailActions}>
              <h3><ShieldCheck aria-hidden="true" /> Identidade</h3>
              <p>O e-mail é a chave de login e de convite: alterá-lo sem verificação deixaria a pessoa sem acesso, então não é editável por aqui.</p>
              <div className={styles.rowActions}>
                <button type="button" disabled={busy} onClick={() => {
                  const name = window.prompt("Novo nome:", data.user.name) ?? "";
                  if (name.trim().length < 2) return;
                  void run(() => patch({ name: name.trim() }));
                }}>Editar nome</button>
                {data.user.status === "active" ? (
                  <button type="button" data-danger="true" disabled={busy} onClick={() => {
                    const reason = window.prompt("Motivo do bloqueio (mínimo 5 caracteres):") ?? "";
                    if (reason.trim().length < 5) return;
                    void run(() => patch({ status: "blocked", reason: reason.trim() }));
                  }}><Ban aria-hidden="true" /> Bloquear</button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void run(() => patch({ status: "active" }))}>
                    <CheckCircle2 aria-hidden="true" /> Desbloquear
                  </button>
                )}
              </div>
            </section>

            <section className={styles.detailActions}>
              <h3><Building2 aria-hidden="true" /> Associações de workspace</h3>
              <p>O papel vale só na associação alterada. Mudar aqui não afeta os outros grupos da pessoa.</p>
              <table className={styles.detailTable}>
                <thead><tr><th>Workspace</th><th>Papel</th><th>Ações</th></tr></thead>
                <tbody>
                  {data.memberships.map((membership) => (
                    <tr key={membership.workspaceId}>
                      <td><strong>{membership.workspaceName}{membership.isOwner ? " · proprietário" : ""}</strong>
                        <small>{workspaceStatusLabels[membership.workspaceStatus] ?? membership.workspaceStatus}</small></td>
                      <td>
                        <select value={membership.role} disabled={busy || membership.isOwner}
                          aria-label={`Papel em ${membership.workspaceName}`}
                          onChange={(event) => void run(() => patch({ workspaceId: membership.workspaceId, membership: "link", role: event.target.value }))}>
                          {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </td>
                      <td>
                        {!membership.isOwner && (
                          <button type="button" data-danger="true" disabled={busy}
                            onClick={() => {
                              if (!window.confirm(`Remover o acesso de ${data.user.name} a ${membership.workspaceName}?`)) return;
                              void run(() => patch({ workspaceId: membership.workspaceId, membership: "unlink" }));
                            }}><Trash2 aria-hidden="true" /> Desvincular</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.memberships.length === 0 && <tr><td colSpan={3}>Sem associação a nenhum workspace.</td></tr>}
                </tbody>
              </table>

              <div className={styles.rowActions}>
                <select value={linkWorkspace} onChange={(event) => setLinkWorkspace(event.target.value)} aria-label="Workspace para vincular">
                  <option value="">Vincular a um workspace…</option>
                  {workspaces.filter((item) => !data.memberships.some((m) => m.workspaceId === item.id))
                    .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <select value={linkRole} onChange={(event) => setLinkRole(event.target.value)} aria-label="Papel na nova associação">
                  {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <button type="button" disabled={busy || !linkWorkspace}
                  onClick={() => void run(async () => {
                    await patch({ workspaceId: linkWorkspace, membership: "link", role: linkRole });
                    setLinkWorkspace("");
                  })}><Link2 aria-hidden="true" /> Vincular</button>
              </div>
            </section>

            <section className={styles.detailActions}>
              <h3><KeyRound aria-hidden="true" /> Sessões ativas</h3>
              <p>Revogar derruba o dispositivo no próximo pedido, sem bloquear a conta.</p>
              <table className={styles.detailTable}>
                <thead><tr><th>Dispositivo</th><th>Último uso</th><th>Ações</th></tr></thead>
                <tbody>
                  {data.sessions.map((session) => (
                    <tr key={session.id}>
                      <td>{session.deviceLabel}</td>
                      <td><time>{when(session.lastSeenAt)}</time></td>
                      <td><button type="button" data-danger="true" disabled={busy}
                        onClick={() => void run(() => patch({ revokeSession: session.id }))}>Revogar</button></td>
                    </tr>
                  ))}
                  {data.sessions.length === 0 && <tr><td colSpan={3}>Nenhuma sessão ativa.</td></tr>}
                </tbody>
              </table>
              {data.sessions.length > 0 && (
                <div className={styles.rowActions}>
                  <button type="button" data-danger="true" disabled={busy}
                    onClick={() => void run(() => patch({ revokeSession: "all" }))}>
                    <RefreshCw aria-hidden="true" /> Encerrar todas as sessões
                  </button>
                </div>
              )}
            </section>

            <section className={styles.detailActions}>
              <h3><Users aria-hidden="true" /> Histórico administrativo</h3>
              <table className={styles.detailTable}>
                <thead><tr><th>Quando</th><th>Ação</th><th>Autor</th></tr></thead>
                <tbody>
                  {data.audit.map((event) => (
                    <tr key={event.id}>
                      <td><time>{when(event.createdAt)}</time></td>
                      <td><strong>{event.action}</strong><small>{event.after}</small></td>
                      <td>{event.actorEmail}</td>
                    </tr>
                  ))}
                  {data.audit.length === 0 && <tr><td colSpan={3}>Nenhum evento registrado.</td></tr>}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
