"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Building2, CheckCircle2, Clock3, KeyRound, RefreshCw, Search, ShieldCheck, Trash2, UserPlus, Users,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { capabilitiesForRole, workspaceRoles } from "@/lib/authorization";
import { capabilitiesOfArea, capabilityAreas, capabilityCatalog, roleLabels, roleSummaries } from "@/lib/capability-catalog";
import {
  createActivationLink, inviteMember, loadAccessOverview, removeMember, updateMemberAccess,
} from "./access.api";
import type { AccessMember, AccessOverview, ActivationLink } from "./access.types";
import { MemberModules } from "./MemberModules";
import { ErrorBanner } from "../shared";
import styles from "./access.module.css";

const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

/** "Nunca acessou" é a informação que importa numa revisão de acesso. */
function lastAccessLabel(member: AccessMember) {
  if (!member.isActivated) return "Ativação pendente";
  if (!member.lastSeenAt) return "Nunca acessou";
  return dateTime(member.lastSeenAt);
}

function initials(name: string) {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** Matriz do que cada papel concede — a resposta para "o que estou liberando?". */
function PermissionMatrix({ highlight }: { highlight: WorkspaceRole | null }) {
  const granted = useMemo(
    () => Object.fromEntries(workspaceRoles.map((role) => [role, new Set(capabilitiesForRole(role))])) as Record<WorkspaceRole, Set<string>>,
    [],
  );

  return (
    <section className={styles.matrixPanel} aria-labelledby="matriz-permissoes">
      <header>
        <div>
          <span className={styles.eyebrow}>O QUE CADA PAPEL PERMITE</span>
          <h3 id="matriz-permissoes">Matriz de permissões</h3>
          <p>Esta é a permissão real aplicada pelo sistema, não uma descrição paralela. Papéis não podem ser editados: escolha o que mais se aproxima da função da pessoa.</p>
        </div>
      </header>

      <div className={styles.roleSummaries}>
        {workspaceRoles.map((role) => (
          <article key={role} data-highlight={highlight === role} >
            <strong>{roleLabels[role]}</strong>
            <p>{roleSummaries[role]}</p>
            <small>{granted[role].size} permissões</small>
          </article>
        ))}
      </div>

      <div className={styles.matrixScroll}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th scope="col">Permissão</th>
              {workspaceRoles.map((role) => <th key={role} scope="col" data-highlight={highlight === role}>{roleLabels[role]}</th>)}
            </tr>
          </thead>
          {capabilityAreas.map((area) => (
            <tbody key={area.key}>
              <tr className={styles.matrixArea}><th scope="rowgroup" colSpan={workspaceRoles.length + 1}>{area.label}</th></tr>
              {capabilitiesOfArea(area.key).map((capability) => (
                <tr key={capability}>
                  <th scope="row">{capabilityCatalog[capability].label}</th>
                  {workspaceRoles.map((role) => (
                    <td key={role} data-role={roleLabels[role]} data-highlight={highlight === role}>
                      {granted[role].has(capability)
                        ? <><CheckCircle2 aria-hidden="true" /><span className={styles.srOnly}>permitido</span></>
                        : <span className={styles.matrixDenied} aria-label="não permitido">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

export function AccessView({ role }: { role: WorkspaceRole }) {
  const [overview, setOverview] = useState<AccessOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | WorkspaceRole>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "never" | "blocked">("all");
  const [selectedId, setSelectedId] = useState("");
  const [draftCompanies, setDraftCompanies] = useState<string[] | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member");
  const [inviteCompanies, setInviteCompanies] = useState<string[]>([]);
  const [activation, setActivation] = useState<ActivationLink | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await loadAccessOverview());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os usuários.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadAccessOverview()
      .then((payload) => { if (active) setOverview(payload); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar os usuários."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const members = useMemo(() => overview?.members ?? [], [overview]);
  const canManage = Boolean(overview?.canManage) && role === "admin";
  const selected = members.find((member) => member.userId === selectedId) ?? null;

  // O rascunho de empresas é derivado da seleção: guardá-lo por efeito faria a
  // tela renderizar duas vezes e piscar o estado anterior. `null` significa
  // "ainda igual ao que está salvo".
  const companyDraft = draftCompanies ?? selected?.companyIds ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return members.filter((member) => {
      if (term && !`${member.name} ${member.email}`.toLowerCase().includes(term)) return false;
      if (roleFilter !== "all" && member.role !== roleFilter) return false;
      if (statusFilter === "pending" && member.isActivated) return false;
      if (statusFilter === "never" && (!member.isActivated || member.lastSeenAt)) return false;
      if (statusFilter === "blocked" && member.status !== "blocked") return false;
      return true;
    });
  }, [members, search, roleFilter, statusFilter]);

  const seats = overview?.seats;
  const seatsFull = Boolean(seats && seats.limit > 0 && seats.used >= seats.limit);
  const pendingCount = members.filter((member) => !member.isActivated).length;
  const neverAccessed = members.filter((member) => member.isActivated && !member.lastSeenAt).length;

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await action();
      await load();
      setToast(success);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
    } finally {
      setBusy(false);
    }
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const link = await inviteMember({
        name: inviteName.trim(), email: inviteEmail.trim().toLowerCase(), role: inviteRole,
        companyIds: inviteRole === "admin" ? [] : inviteCompanies,
      });
      setActivation(link);
      setInviteOpen(false);
      setInviteName("");
      setInviteEmail("");
      setInviteCompanies([]);
    }, "Usuário criado. Copie o link de ativação e entregue à pessoa.");
  }

  if (loading) {
    return <section className={styles.workspace}><div className={styles.loading}><RefreshCw className={styles.spin} aria-hidden="true" /><strong>Carregando usuários…</strong></div></section>;
  }

  if (!overview) {
    return (
      <section className={styles.workspace}>
        <div className={styles.blocked} role="alert">
          <AlertTriangle aria-hidden="true" />
          <strong>Não foi possível carregar os usuários</strong>
          <p>{error}</p>
          <button type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.workspace}>
      <header className={styles.commandDeck}>
        <div>
          <span className={styles.eyebrow}>ACESSO DO GRUPO</span>
          <h2>Usuários e permissões</h2>
          <p>Defina quem entra, o que cada pessoa pode fazer e quais empresas ela enxerga. Cada alteração fica registrada na trilha de auditoria com autor e horário.</p>
        </div>
        <div className={styles.seatMeter} data-tone={seatsFull ? "danger" : "safe"}>
          <span><Users aria-hidden="true" /> ASSENTOS</span>
          <strong>{seats?.used ?? members.length}{seats && seats.limit > 0 ? ` / ${seats.limit}` : ""}</strong>
          <small>
            {seats && seats.limit > 0
              ? `Plano ${seats.planName}${seatsFull ? " · limite atingido" : ` · ${seats.limit - seats.used} livre(s)`}`
              : "Sem assinatura ativa: fale com o administrador da plataforma."}
          </small>
        </div>
        {canManage && (
          <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => setInviteOpen(true)}>
            <UserPlus aria-hidden="true" /> Novo usuário
          </button>
        )}
      </header>

      {error && <ErrorBanner title="A operação não foi concluída" message={error} onDismiss={() => setError("")} />}

      {activation && (
        <section className={styles.activationPanel} aria-live="polite">
          <div>
            <span className={styles.eyebrow}>LINK ÚNICO DE ATIVAÇÃO</span>
            <strong>{activation.name}</strong>
            <small>Válido até {dateTime(activation.expiresAt)}. Ele deixa de funcionar depois do primeiro uso — a senha é definida pela própria pessoa e nunca fica visível aqui.</small>
          </div>
          <input value={activation.url} readOnly aria-label="Link de ativação" />
          <button type="button" className={styles.secondaryButton} onClick={() => { void navigator.clipboard.writeText(activation.url).then(() => setToast("Link copiado.")); }}>Copiar</button>
          <button type="button" className={styles.secondaryButton} onClick={() => setActivation(null)}>Ocultar</button>
        </section>
      )}

      <div className={styles.reviewStrip}>
        <article><strong>{members.length}</strong><span>com acesso ao grupo</span></article>
        <article data-tone={pendingCount ? "warning" : "safe"}><strong>{pendingCount}</strong><span>com ativação pendente</span></article>
        <article data-tone={neverAccessed ? "warning" : "safe"}><strong>{neverAccessed}</strong><span>nunca acessaram</span></article>
        <article><strong>{members.filter((member) => member.role === "admin").length}</strong><span>administradores</span></article>
      </div>

      <section className={styles.listPanel}>
        <header>
          <div className={styles.searchField}>
            <Search aria-hidden="true" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome ou e-mail" aria-label="Buscar usuário" />
          </div>
          <label>Papel
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as typeof roleFilter)}>
              <option value="all">Todos</option>
              {workspaceRoles.map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}
            </select>
          </label>
          <label>Situação
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">Todas</option>
              <option value="pending">Ativação pendente</option>
              <option value="never">Nunca acessaram</option>
              <option value="blocked">Bloqueados</option>
            </select>
          </label>
          <span className={styles.resultCount}>{filtered.length} de {members.length}</span>
        </header>

        {filtered.length === 0 ? (
          <div className={styles.empty}><Users aria-hidden="true" /><strong>Nenhum usuário nesse filtro</strong><p>Ajuste a busca ou o filtro para ver as pessoas com acesso ao grupo.</p></div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.memberTable}>
              <thead>
                <tr>
                  <th scope="col">Pessoa</th>
                  <th scope="col">Papel</th>
                  <th scope="col">Empresas</th>
                  <th scope="col">Último acesso</th>
                  <th scope="col">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((member) => (
                  <tr key={member.userId} data-selected={member.userId === selectedId}>
                    <td data-label="Pessoa">
                      <div className={styles.person}>
                        <i>{initials(member.name)}</i>
                        <div>
                          <strong>{member.name}{member.isOwner && <em>proprietário</em>}</strong>
                          <small>{member.email}</small>
                          {member.status === "blocked" && <span className={styles.badgeDanger}>Bloqueado pela plataforma</span>}
                          {member.status !== "blocked" && !member.isActivated && <span className={styles.badgeWarning}>Ativação pendente</span>}
                        </div>
                      </div>
                    </td>
                    <td data-label="Papel">
                      {canManage && !member.isOwner ? (
                        <select
                          aria-label={`Papel de ${member.name}`}
                          value={member.role}
                          disabled={busy}
                          onChange={(event) => void run(
                            () => updateMemberAccess(member.userId, { role: event.target.value as WorkspaceRole }),
                            `Papel de ${member.name} atualizado.`,
                          )}
                        >
                          {workspaceRoles.map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}
                        </select>
                      ) : <span className={styles.rolePlain}>{roleLabels[member.role]}</span>}
                    </td>
                    <td data-label="Empresas">
                      {member.role === "admin"
                        ? <span className={styles.scopeAll}><Building2 aria-hidden="true" /> Todas as empresas</span>
                        : <span className={styles.scopeCount}>{member.companyIds.length === 0 ? "Nenhuma empresa liberada" : `${member.companyIds.length} empresa(s)`}</span>}
                    </td>
                    <td data-label="Último acesso"><span className={styles.lastAccess}><Clock3 aria-hidden="true" /> {lastAccessLabel(member)}</span></td>
                    <td data-label="Ações">
                      <div className={styles.rowActions}>
                        <button type="button" className={styles.secondaryButton} onClick={() => { setDraftCompanies(null); setSelectedId(member.userId === selectedId ? "" : member.userId); }}>
                          <ShieldCheck aria-hidden="true" /> {member.userId === selectedId ? "Fechar" : "Acessos"}
                        </button>
                        {canManage && !member.isOwner && (
                          <button type="button" className={styles.secondaryButton} disabled={busy}
                            onClick={() => void run(async () => { setActivation(await createActivationLink(member.userId)); }, "Link de ativação gerado.")}>
                            <KeyRound aria-hidden="true" /> {member.isActivated ? "Novo link" : "Ativar"}
                          </button>
                        )}
                        {canManage && !member.isOwner && (
                          <button type="button" className={styles.dangerButton} disabled={busy}
                            onClick={() => {
                              if (!window.confirm(`Remover o acesso de ${member.name} a este grupo? A conta continua existindo, mas perde o acesso.`)) return;
                              void run(() => removeMember(member.userId), `${member.name} não tem mais acesso ao grupo.`);
                            }}>
                            <Trash2 aria-hidden="true" /> Remover
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

      {selected && (
        <section className={styles.detailPanel} aria-label={`Acessos de ${selected.name}`}>
          <header>
            <div>
              <span className={styles.eyebrow}>ESCOPO POR EMPRESA</span>
              <strong>{selected.name}</strong>
              <small>{roleLabels[selected.role]} · {selected.email}</small>
            </div>
            <button type="button" className={styles.secondaryButton} onClick={() => { setDraftCompanies(null); setSelectedId(""); }}>Fechar</button>
          </header>

          {selected.role === "admin" ? (
            <p className={styles.detailNote}><Building2 aria-hidden="true" /> Administradores enxergam todas as empresas do grupo. Para restringir o alcance de alguém, use o papel Membro ou Observador.</p>
          ) : (
            <>
              <p className={styles.detailNote}>Marque as empresas que esta pessoa pode operar. Sem nenhuma empresa marcada, ela entra no grupo mas não enxerga dado de nenhum CNPJ.</p>
              <div className={styles.companyGrid}>
                {overview.companies.length === 0 && <span className={styles.detailEmpty}>Nenhuma empresa cadastrada neste grupo ainda.</span>}
                {overview.companies.map((company) => (
                  <label key={company.id}>
                    <input
                      type="checkbox"
                      disabled={!canManage || busy}
                      checked={companyDraft.includes(company.id)}
                      onChange={(event) => setDraftCompanies(
                        event.target.checked ? [...companyDraft, company.id] : companyDraft.filter((id) => id !== company.id),
                      )}
                    />
                    <span>{company.isPrincipal ? "★ " : "↳ "}{company.name}</span>
                  </label>
                ))}
              </div>
              {canManage && (
                <div className={styles.detailActions}>
                  <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => setDraftCompanies(null)}>Descartar</button>
                  <button type="button" className={styles.primaryButton} disabled={busy}
                    onClick={() => void run(() => updateMemberAccess(selected.userId, { companyIds: companyDraft }), `Empresas de ${selected.name} atualizadas.`)}>
                    Salvar empresas
                  </button>
                </div>
              )}
            </>
          )}

          {/* Escopo por empresa responde "quais CNPJs"; a matriz abaixo responde
              "quais telas". As duas perguntas vivem na mesma ficha porque quem
              revisa acesso precisa das duas ao mesmo tempo. */}
          <div className={styles.detailNote}>
            <span className={styles.eyebrow}>ACESSO A MÓDULOS</span>
          </div>
          <MemberModules memberId={selected.userId} memberName={selected.name} canManage={canManage} />
        </section>
      )}

      <PermissionMatrix highlight={selected?.role ?? null} />

      {inviteOpen && (
        <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setInviteOpen(false); }}>
          <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="novo-usuario" onSubmit={submitInvite}>
            <header>
              <div>
                <span className={styles.eyebrow}>ACESSO DO GRUPO</span>
                <h3 id="novo-usuario">Novo usuário</h3>
                <p>A pessoa recebe um link único para definir a própria senha. Nenhuma senha é criada, exibida ou enviada por aqui.</p>
              </div>
              <button type="button" onClick={() => setInviteOpen(false)} aria-label="Fechar">×</button>
            </header>

            {seatsFull && (
              <p className={styles.modalWarning} role="alert">
                <AlertTriangle aria-hidden="true" />
                O plano {seats?.planName} permite {seats?.limit} usuário(s) e todos estão em uso. Remova alguém ou mude de plano antes de criar mais um acesso.
              </p>
            )}

            <label>Nome<input name="name" value={inviteName} onChange={(event) => setInviteName(event.target.value)} maxLength={120} placeholder="Nome da pessoa" required /></label>
            <label>E-mail<input name="email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="nome@empresa.com" required /></label>
            <label>Papel
              <select name="role" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}>
                {workspaceRoles.map((item) => <option key={item} value={item}>{roleLabels[item]}</option>)}
              </select>
            </label>
            <p className={styles.roleHint}>{roleSummaries[inviteRole]}</p>

            <fieldset disabled={inviteRole === "admin"}>
              <legend>{inviteRole === "admin" ? "Administrador acessa todas as empresas" : "Empresas liberadas"}</legend>
              <div className={styles.companyGrid}>
                {overview.companies.map((company) => (
                  <label key={company.id}>
                    <input type="checkbox" checked={inviteCompanies.includes(company.id)}
                      onChange={(event) => setInviteCompanies((current) => (
                        event.target.checked ? [...current, company.id] : current.filter((id) => id !== company.id)
                      ))} />
                    <span>{company.isPrincipal ? "★ " : "↳ "}{company.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <footer>
              <button type="button" className={styles.secondaryButton} onClick={() => setInviteOpen(false)}>Cancelar</button>
              <button className={styles.primaryButton} disabled={busy || seatsFull}>Criar usuário e gerar link</button>
            </footer>
          </form>
        </div>
      )}

      {toast && <div className={styles.toast} role="status"><CheckCircle2 aria-hidden="true" /> {toast}</div>}
    </section>
  );
}
