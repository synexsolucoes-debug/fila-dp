"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban, Building2, CheckCircle2, CircleAlert, ExternalLink, LoaderCircle, Plus, RefreshCw, Search, ShieldCheck, Trash2, UserCheck, Users,
} from "lucide-react";
import styles from "./platform.module.css";
import { UserDetailDrawer, WorkspaceDetailDrawer } from "./PlatformDetail";

/**
 * Console global do Vinculato — administração do SaaS.
 *
 * Cada ação aqui chama uma rota que valida `requirePlatformAdmin` no servidor e
 * grava trilha em `fdp_platform_audit_events`. Não há botão decorativo: se algo
 * aparece na tela, existe rota por trás e o efeito é verificável no banco.
 */
type Row = Record<string, unknown>;

export type Workspace = {
  id: string; name: string; slug: string; status: string; statusReason: string;
  ownerEmail: string; ownerName: string; planCode: string; planName: string;
  subscriptionStatus: string; seatsUsed: number; seatLimit: number; companies: number; createdAt: string;
};

export type PlatformUser = {
  id: string; email: string; name: string; status: string; statusReason: string;
  hasPassword: boolean; workspaces: number; workspaceNames: string; lastSeenAt: string;
};

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const number = (value: unknown) => Number(value) || 0;
const when = (value: string) => {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(parsed);
};

const workspaceStatusLabels: Record<string, string> = {
  active: "Ativo", suspended: "Suspenso", canceled: "Cancelado", archived: "Arquivado",
};
const statusTone = (status: string) =>
  status === "active" ? "safe" : status === "suspended" ? "warning" : status === "blocked" ? "danger" : "danger";

export function normalizeWorkspace(row: Row): Workspace {
  return {
    id: text(row.id), name: text(row.name), slug: text(row.slug),
    status: text(row.status) || "active", statusReason: text(row.status_reason),
    ownerEmail: text(row.owner_email), ownerName: text(row.owner_name),
    planCode: text(row.plan_code), planName: text(row.plan_name),
    subscriptionStatus: text(row.subscription_status),
    seatsUsed: number(row.seats_used),
    seatLimit: Math.max(number(row.seat_quantity), number(row.included_seats)),
    companies: number(row.companies), createdAt: text(row.created_at),
  };
}

export function normalizePlatformUser(row: Row): PlatformUser {
  return {
    id: text(row.id), email: text(row.email), name: text(row.name),
    status: text(row.status) || "active", statusReason: text(row.status_reason),
    hasPassword: row.has_password === true,
    workspaces: number(row.workspaces), workspaceNames: text(row.workspace_names),
    lastSeenAt: text(row.last_seen_at),
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Não foi possível concluir a operação.");
  return payload;
}

type Tab = "workspaces" | "users";

export function PlatformConsole({ plans }: { plans: { code: string; name: string }[] }) {
  const [tab, setTab] = useState<Tab>("workspaces");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  // Abrir um cliente ou uma identidade: o console listava sem permitir entrar.
  const [openWorkspace, setOpenWorkspace] = useState("");
  const [openUser, setOpenUser] = useState("");

  const load = useCallback(async (activeTab: Tab, search: string, status: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (status) params.set("status", status);
      if (activeTab === "workspaces") {
        const payload = await request<{ workspaces?: Row[] }>(`/api/platform/workspaces?${params}`);
        setWorkspaces((payload.workspaces ?? []).map(normalizeWorkspace));
      } else {
        const payload = await request<{ users?: Row[] }>(`/api/platform/users?${params}`);
        setUsers((payload.users ?? []).map(normalizePlatformUser));
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao carregar.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load(tab, query, statusFilter));
    return () => window.cancelAnimationFrame(frame);
  }, [load, tab, query, statusFilter]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function act(key: string, run: () => Promise<unknown>, message: string) {
    setBusy(key);
    try {
      await run();
      setNotice(message);
      setError("");
      await load(tab, query, statusFilter);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
    } finally {
      setBusy("");
    }
  }

  /** Toda ação que corta acesso pede motivo — o banco também exige. */
  function withReason(title: string, run: (reason: string) => Promise<unknown>, key: string, message: string) {
    const reason = window.prompt(`${title}\n\nInforme o motivo (mínimo 5 caracteres):`) ?? "";
    if (reason.trim().length < 5) {
      setError("O motivo precisa ter pelo menos 5 caracteres.");
      return;
    }
    void act(key, () => run(reason.trim()), message);
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? "").trim();
    await act("create", () => request("/api/platform/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name: field("name"), slug: field("slug"), ownerEmail: field("ownerEmail"), ownerName: field("ownerName"),
        planCode: field("planCode"), legalName: field("legalName"), taxId: field("taxId"), contactEmail: field("contactEmail"),
      }),
    }), "Workspace criado com proprietário e assinatura.");
    setCreating(false);
  }

  const totals = useMemo(() => ({
    workspaces: workspaces.length,
    suspended: workspaces.filter((item) => item.status !== "active").length,
    blocked: users.filter((item) => item.status === "blocked").length,
  }), [users, workspaces]);

  return (
    <>
      <div className={styles.tabs} role="tablist" aria-label="Áreas do console global">
        <button type="button" role="tab" aria-selected={tab === "workspaces"} onClick={() => setTab("workspaces")}>
          <Building2 aria-hidden="true" /> Workspaces {totals.workspaces > 0 && <b>{totals.workspaces}</b>}
        </button>
        <button type="button" role="tab" aria-selected={tab === "users"} onClick={() => setTab("users")}>
          <Users aria-hidden="true" /> Usuários {totals.blocked > 0 && <b>{totals.blocked}</b>}
        </button>
      </div>

      <div className={styles.toolbar}>
        <label style={{ display: "contents" }}>
          <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            {tab === "workspaces" ? "Buscar workspace por nome, identificador ou CNPJ" : "Buscar usuário por nome ou e-mail"}
          </span>
          <input
            type="search"
            value={query}
            placeholder={tab === "workspaces" ? "Buscar por nome, identificador ou CNPJ" : "Buscar por nome ou e-mail"}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select aria-label="Filtrar por situação" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">Todas as situações</option>
          {tab === "workspaces"
            ? Object.entries(workspaceStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)
            : [<option key="active" value="active">Ativo</option>, <option key="blocked" value="blocked">Bloqueado</option>]}
        </select>
        <button type="button" className={styles.primary} onClick={() => void load(tab, query, statusFilter)} disabled={loading}>
          <RefreshCw aria-hidden="true" className={loading ? styles.spin : ""} /> Atualizar
        </button>
        {tab === "workspaces" && (
          <button type="button" className={styles.primary} onClick={() => setCreating(true)} disabled={Boolean(busy)}>
            <Plus aria-hidden="true" /> Novo workspace
          </button>
        )}
      </div>

      {error && <div className={styles.error} role="alert"><CircleAlert aria-hidden="true" />{error}<button type="button" onClick={() => setError("")}>Fechar</button></div>}

      <section className={styles.workspacesPanel} aria-live="polite">
        {loading ? (
          <div className={styles.empty}><LoaderCircle className={styles.spin} aria-hidden="true" /><strong>Carregando</strong></div>
        ) : tab === "workspaces" ? (
          workspaces.length === 0 ? (
            <div className={styles.empty}><Building2 aria-hidden="true" /><strong>Nenhum workspace encontrado</strong><p>Ajuste a busca ou crie o primeiro cliente.</p></div>
          ) : (
            <div className={styles.tableWrap}>
              <table>
                <caption className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Workspaces do Vinculato</caption>
                <thead>
                  <tr>
                    <th scope="col">Workspace</th><th scope="col">Proprietário</th><th scope="col">Plano</th>
                    <th scope="col">Assentos</th><th scope="col">Situação</th><th scope="col">Criado</th><th scope="col">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {workspaces.map((workspace) => {
                    const full = workspace.seatLimit > 0 && workspace.seatsUsed >= workspace.seatLimit;
                    return (
                      <tr key={workspace.id}>
                        <td><strong>{workspace.name}</strong><small>{workspace.slug} · {workspace.companies} empresa(s)</small></td>
                        <td><strong>{workspace.ownerName}</strong><small>{workspace.ownerEmail}</small></td>
                        <td>
                          <select
                            aria-label={`Plano de ${workspace.name}`}
                            value={workspace.planCode}
                            disabled={busy === workspace.id}
                            onChange={(event) => void act(workspace.id,
                              () => request(`/api/platform/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ planCode: event.target.value }) }),
                              `Plano de ${workspace.name} atualizado.`)}
                          >
                            {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
                          </select>
                        </td>
                        <td>
                          <div className={styles.seatBar} data-full={full ? "true" : "false"}>
                            <strong>{workspace.seatsUsed} / {workspace.seatLimit || "—"}</strong>
                            <span><i style={{ width: `${workspace.seatLimit ? Math.min(100, (workspace.seatsUsed / workspace.seatLimit) * 100) : 0}%` }} /></span>
                          </div>
                        </td>
                        <td>
                          <span className={styles.status} data-tone={statusTone(workspace.status)}>
                            {workspaceStatusLabels[workspace.status] ?? workspace.status}
                          </span>
                          {workspace.statusReason && <small>{workspace.statusReason}</small>}
                        </td>
                        <td><time>{when(workspace.createdAt)}</time></td>
                        <td>
                          <div className={styles.rowActions}>
                            <button type="button" onClick={() => setOpenWorkspace(workspace.id)}>
                              <ExternalLink aria-hidden="true" /> Abrir
                            </button>
                            {workspace.status === "active" ? (
                              <button type="button" data-danger="true" disabled={busy === workspace.id}
                                onClick={() => withReason(`Suspender ${workspace.name}`,
                                  (reason) => request(`/api/platform/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended", reason }) }),
                                  workspace.id, `${workspace.name} suspenso.`)}>
                                <Ban aria-hidden="true" /> Suspender
                              </button>
                            ) : (
                              <button type="button" disabled={busy === workspace.id}
                                onClick={() => void act(workspace.id,
                                  () => request(`/api/platform/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }),
                                  `${workspace.name} reativado.`)}>
                                <CheckCircle2 aria-hidden="true" /> Reativar
                              </button>
                            )}
                            <button type="button" disabled={busy === workspace.id}
                              onClick={() => {
                                const email = window.prompt(`Transferir a propriedade de ${workspace.name}\n\nE-mail do novo proprietário (a conta precisa existir):`) ?? "";
                                if (!email.trim()) return;
                                void act(workspace.id,
                                  () => request(`/api/platform/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ ownerEmail: email.trim() }) }),
                                  "Propriedade transferida.");
                              }}>
                              <UserCheck aria-hidden="true" /> Transferir
                            </button>
                            {workspace.status !== "archived" && (
                              <button type="button" data-danger="true" disabled={busy === workspace.id}
                                onClick={() => withReason(`Arquivar ${workspace.name}`,
                                  (reason) => request(`/api/platform/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ status: "archived", reason }) }),
                                  workspace.id, `${workspace.name} arquivado.`)}>
                                <Trash2 aria-hidden="true" /> Arquivar
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : users.length === 0 ? (
          <div className={styles.empty}><Search aria-hidden="true" /><strong>Nenhum usuário encontrado</strong><p>Busque por nome ou e-mail.</p></div>
        ) : (
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Usuário</th><th scope="col">Workspaces</th><th scope="col">Acesso</th>
                  <th scope="col">Último acesso</th><th scope="col">Situação</th><th scope="col">Ações</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td><strong>{user.name || user.email}</strong><small>{user.email}</small></td>
                    <td><strong>{user.workspaces}</strong><small>{user.workspaceNames || "sem vínculo"}</small></td>
                    {/* Nunca exibimos hash de senha: só se existe senha definida. */}
                    <td>{user.hasPassword ? "Senha definida" : "Aguardando primeiro acesso"}</td>
                    <td><time>{when(user.lastSeenAt)}</time></td>
                    <td>
                      <span className={styles.status} data-tone={statusTone(user.status)}>
                        {user.status === "blocked" ? "Bloqueado" : "Ativo"}
                      </span>
                      {user.statusReason && <small>{user.statusReason}</small>}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <button type="button" onClick={() => setOpenUser(user.id)}>
                          <ExternalLink aria-hidden="true" /> Abrir
                        </button>
                        {user.status === "active" ? (
                          <button type="button" data-danger="true" disabled={busy === user.id}
                            onClick={() => withReason(`Bloquear ${user.email}`,
                              (reason) => request(`/api/platform/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ status: "blocked", reason }) }),
                              user.id, "Usuário bloqueado e sessões encerradas.")}>
                            <Ban aria-hidden="true" /> Bloquear
                          </button>
                        ) : (
                          <button type="button" disabled={busy === user.id}
                            onClick={() => void act(user.id,
                              () => request(`/api/platform/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }),
                              "Usuário desbloqueado.")}>
                            <CheckCircle2 aria-hidden="true" /> Desbloquear
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {creating && (
        <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCreating(false); }}>
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="new-workspace-title">
            <header>
              <div>
                <span>ADMINISTRAÇÃO DA PLATAFORMA</span>
                <h2 id="new-workspace-title">Novo workspace</h2>
                <p>Cria cliente, proprietário e assinatura em uma única transação.</p>
              </div>
              <button type="button" onClick={() => setCreating(false)} aria-label="Fechar">×</button>
            </header>
            <form onSubmit={createWorkspace}>
              <div className={styles.drawerBody}>
                <div className={styles.publicOnly}>
                  <ShieldCheck aria-hidden="true" />
                  <div>
                    <strong>Nenhuma senha é criada aqui</strong>
                    <span>O proprietário define a senha pelo fluxo de recuperação de acesso. Nunca geramos senha padrão.</span>
                  </div>
                </div>
                <section>
                  <header><strong>Identificação</strong></header>
                  <div className={styles.formGrid}>
                    <label className="wide">Nome do workspace<input name="name" required minLength={2} maxLength={120} /></label>
                    <label>Identificador (opcional)<input name="slug" maxLength={60} placeholder="gerado automaticamente" /></label>
                    <label>Plano
                      <select name="planCode" defaultValue="starter">
                        {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
                      </select>
                    </label>
                    <label>Razão social<input name="legalName" maxLength={200} /></label>
                    <label>CNPJ<input name="taxId" maxLength={20} inputMode="numeric" /></label>
                  </div>
                </section>
                <section>
                  <header><strong>Proprietário</strong></header>
                  <div className={styles.formGrid}>
                    <label>Nome<input name="ownerName" maxLength={160} /></label>
                    <label>E-mail<input name="ownerEmail" type="email" required maxLength={180} /></label>
                    <label className="wide">E-mail de contato do grupo<input name="contactEmail" type="email" maxLength={180} /></label>
                  </div>
                </section>
              </div>
              <footer>
                <button type="button" onClick={() => setCreating(false)} disabled={Boolean(busy)}>Cancelar</button>
                <button type="submit" disabled={Boolean(busy)}>{busy === "create" ? "Criando…" : "Criar workspace"}</button>
              </footer>
            </form>
          </div>
        </div>
      )}

      {openWorkspace && (
        <div className={styles.drawerBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenWorkspace(""); }}>
          <WorkspaceDetailDrawer id={openWorkspace} plans={plans}
            onClose={() => setOpenWorkspace("")} onChanged={() => void load(tab, query, statusFilter)} />
        </div>
      )}

      {openUser && (
        <div className={styles.drawerBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenUser(""); }}>
          <UserDetailDrawer id={openUser} workspaces={workspaces.map((item) => ({ id: item.id, name: item.name }))}
            onClose={() => setOpenUser("")} onChanged={() => void load(tab, query, statusFilter)} />
        </div>
      )}

      {notice && <p className={styles.toast} role="status"><CheckCircle2 aria-hidden="true" />{notice}</p>}
    </>
  );
}
