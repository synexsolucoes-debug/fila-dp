"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Briefcase, CalendarOff, RefreshCw, UserRoundX } from "lucide-react";
import { dpStatusLabels, dpStatuses, type DpStatus } from "@/lib/portfolio";
import { ConfirmDialog, EmptyState, ErrorBanner, PageSkeleton } from "../shared";
import styles from "./portfolio.module.css";

/**
 * Carteira do DP (Fase 1 do DP Operacional).
 *
 * Responde "quem responde por cada empresa?" e substitui a aba Empresas da
 * planilha de controle. A troca de titular encerra a vigência anterior e leva
 * as demandas em aberto para o novo titular — a confirmação diz quantas antes.
 * Ausências desviam as demandas *novas* para o backup; as que já estão com a
 * pessoa só mudam pelo botão "Passar abertas para o backup".
 */

type PortfolioCompany = {
  id: string;
  code: string;
  name: string;
  legalName: string;
  taxId: string;
  cnpjRoot: string;
  isHeadquarters: boolean;
  dpStatus: DpStatus;
  holderUserId: string | null;
  holderName: string | null;
  backupUserId: string | null;
  backupName: string | null;
  validFrom: string | null;
  activeEmployees: number;
  openCards: number;
  unassignedCards: number;
  holderOpenCards: number;
};

type Member = { id: string; name: string; email: string };
type Absence = { id: string; userId: string; userName: string; startsOn: string; endsOn: string; reason: string };
type Payload = { today: string; unassignedCards: number; companies: PortfolioCompany[]; members: Member[]; absences: Absence[] };

type PendingChange = { company: PortfolioCompany; holderUserId: string; backupUserId: string | null };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function formatDate(value: string) {
  const [year, month, day] = value.split("-");
  return day ? `${day}/${month}/${year}` : value;
}

function formatCnpj(value: string) {
  const digits = value.replace(/\D/gu, "");
  if (digits.length !== 14) return value || "CNPJ a cadastrar";
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

export function PortfolioView({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [absenceForm, setAbsenceForm] = useState({ userId: "", startsOn: "", endsOn: "", reason: "" });

  const load = useCallback(async () => {
    try {
      const payload = await request<Payload>("/api/portfolio");
      setData(payload);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar a carteira."); }
  }, []);

  // Fora do corpo do efeito, como em HistoryView: a carga assíncrona não
  // dispara setState síncrono no mesmo ciclo de renderização.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const memberName = useMemo(() => new Map((data?.members ?? []).map((member) => [member.id, member.name])), [data]);
  const withoutPortfolio = (data?.companies ?? []).filter((company) => !company.holderUserId && company.dpStatus === "interno").length;

  function askChange(company: PortfolioCompany, holderUserId: string, backupUserId: string | null) {
    if (!holderUserId) return;
    // Promover o backup a titular troca os dois de lugar: quem era titular
    // vira backup, em vez de a empresa ficar sem ninguém de reserva.
    const backup = backupUserId === holderUserId ? company.holderUserId : backupUserId;
    setPending({ company, holderUserId, backupUserId: backup && backup !== holderUserId ? backup : null });
  }

  async function confirmChange() {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await request<{ changed: boolean; reassigned: number }>("/api/portfolio", {
        method: "POST",
        body: JSON.stringify({ companyId: pending.company.id, holderUserId: pending.holderUserId, backupUserId: pending.backupUserId }),
      });
      setNotice(result.changed
        ? `Carteira de ${pending.company.name} atualizada. ${result.reassigned} demanda(s) em aberto passaram para ${memberName.get(pending.holderUserId) ?? "o novo titular"}.`
        : "Nada mudou: titular e backup já eram esses.");
      setPending(null);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível trocar a carteira."); }
    finally { setBusy(false); }
  }

  async function changeStatus(company: PortfolioCompany, dpStatus: string) {
    setBusy(true);
    try {
      await request("/api/portfolio", { method: "PATCH", body: JSON.stringify({ companyId: company.id, dpStatus }) });
      setNotice(`Situação de ${company.name} alterada para ${dpStatusLabels[dpStatus as DpStatus]}.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível alterar a situação."); }
    finally { setBusy(false); }
  }

  async function addAbsence(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await request("/api/portfolio/absences", { method: "POST", body: JSON.stringify(absenceForm) });
      setNotice(`Ausência de ${memberName.get(absenceForm.userId) ?? "membro"} registrada. No período, demandas novas das empresas em que a pessoa é titular irão para o backup.`);
      setAbsenceForm({ userId: "", startsOn: "", endsOn: "", reason: "" });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível registrar a ausência."); }
    finally { setBusy(false); }
  }

  async function removeAbsence(absence: Absence) {
    setBusy(true);
    try {
      await request(`/api/portfolio/absences/${encodeURIComponent(absence.id)}`, { method: "DELETE" });
      setNotice("Ausência cancelada.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível cancelar a ausência."); }
    finally { setBusy(false); }
  }

  async function handOver(absence: Absence) {
    setBusy(true);
    try {
      const result = await request<{ reassigned: number; withoutBackup: string[] }>("/api/portfolio/handover", {
        method: "POST", body: JSON.stringify({ userId: absence.userId }),
      });
      const missing = result.withoutBackup.length ? ` ${result.withoutBackup.length} empresa(s) sem backup ficaram como estavam.` : "";
      setNotice(`${result.reassigned} demanda(s) em aberto de ${absence.userName} passaram para o backup.${missing}`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível repassar as demandas."); }
    finally { setBusy(false); }
  }

  if (!data && !error) return <PageSkeleton label="Carregando a carteira do DP" rows={8} metrics={3} />;

  const pendingConsequence = pending
    ? [
      `${memberName.get(pending.holderUserId) ?? "Novo titular"} passa a responder por ${pending.company.name}`,
      pending.backupUserId ? `com ${memberName.get(pending.backupUserId) ?? "backup"} de backup` : "sem backup",
      `a partir de hoje (${formatDate(data?.today ?? "")}).`,
      pending.company.holderUserId && pending.company.holderUserId !== pending.holderUserId
        ? `${pending.company.holderOpenCards} demanda(s) em aberto com ${pending.company.holderName} passarão para o novo titular; as concluídas continuam com quem as concluiu.`
        : "",
      "A vigência anterior é encerrada, não apagada.",
    ].filter(Boolean).join(" ")
    : "";

  return <div className={styles.portfolio}>
    {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
    {notice && <p className={styles.notice} role="status">{notice}</p>}

    <section className={styles.metrics} aria-label="Resumo da carteira">
      <article><span>Empresas</span><strong>{data?.companies.length ?? 0}</strong></article>
      <article data-tone={withoutPortfolio ? "warn" : undefined}><span>Internas sem titular</span><strong>{withoutPortfolio}</strong></article>
      <article data-tone={data?.unassignedCards ? "warn" : undefined}><span>Demandas sem responsável</span><strong>{data?.unassignedCards ?? 0}</strong></article>
    </section>

    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <div><h3>Empresas e responsáveis</h3><p>Demanda nova nasce com o titular; com o titular ausente, com o backup.</p></div>
        <button type="button" className={styles.ghostButton} onClick={() => void load()} disabled={busy}><RefreshCw aria-hidden="true" /> Atualizar</button>
      </header>
      {!data?.companies.length
        ? <EmptyState icon={Briefcase} title="Nenhuma empresa ativa" text="Cadastre as empresas em Cadastros para montar a carteira." size="compact" />
        : <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>Cód.</th><th>Empresa</th><th>Situação</th><th>Titular</th><th>Backup</th><th className={styles.number}>Ativos</th><th className={styles.number}>Abertas</th></tr></thead>
          <tbody>{data.companies.map((company) => <tr key={company.id}>
            <td>{company.code || "—"}</td>
            <td><strong>{company.name}</strong><small>{formatCnpj(company.taxId)}{company.cnpjRoot ? ` · ${company.isHeadquarters ? "Matriz" : "Filial"}` : ""}</small></td>
            <td>{canManage
              ? <select aria-label={`Situação de ${company.name}`} value={company.dpStatus} disabled={busy} onChange={(event) => void changeStatus(company, event.target.value)}>
                {dpStatuses.map((status) => <option key={status} value={status}>{dpStatusLabels[status]}</option>)}
              </select>
              : dpStatusLabels[company.dpStatus]}</td>
            <td>{canManage
              ? <select aria-label={`Titular de ${company.name}`} value={company.holderUserId ?? ""} disabled={busy}
                onChange={(event) => askChange(company, event.target.value, company.backupUserId)}>
                <option value="" disabled>Sem titular</option>
                {data.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
              : company.holderName ?? "Sem titular"}
              {company.validFrom && <small>desde {formatDate(company.validFrom)}</small>}</td>
            <td>{canManage
              ? <select aria-label={`Backup de ${company.name}`} value={company.backupUserId ?? ""} disabled={busy || !company.holderUserId}
                onChange={(event) => company.holderUserId && askChange(company, company.holderUserId, event.target.value || null)}>
                <option value="">Sem backup</option>
                {data.members.filter((member) => member.id !== company.holderUserId).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
              : company.backupName ?? "Sem backup"}</td>
            <td className={styles.number}>{company.activeEmployees}</td>
            <td className={styles.number}>{company.openCards}{company.unassignedCards ? <small className={styles.warn}>{company.unassignedCards} sem resp.</small> : null}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <div><h3>Ausências da equipe</h3><p>Férias e folgas: no período, demanda nova das empresas da pessoa vai para o backup.</p></div>
      </header>
      {canManage && <form className={styles.absenceForm} onSubmit={(event) => void addAbsence(event)}>
        <label><span>Quem</span><select required value={absenceForm.userId} onChange={(event) => setAbsenceForm({ ...absenceForm, userId: event.target.value })}>
          <option value="">Selecione</option>
          {data?.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></label>
        <label><span>Início</span><input type="date" required value={absenceForm.startsOn} onChange={(event) => setAbsenceForm({ ...absenceForm, startsOn: event.target.value })} /></label>
        <label><span>Fim</span><input type="date" required min={absenceForm.startsOn || undefined} value={absenceForm.endsOn} onChange={(event) => setAbsenceForm({ ...absenceForm, endsOn: event.target.value })} /></label>
        <label className={styles.grow}><span>Motivo</span><input maxLength={200} placeholder="Férias, folga…" value={absenceForm.reason} onChange={(event) => setAbsenceForm({ ...absenceForm, reason: event.target.value })} /></label>
        <button type="submit" className={styles.primaryButton} disabled={busy}>Registrar ausência</button>
      </form>}
      {!data?.absences.length
        ? <EmptyState icon={CalendarOff} title="Nenhuma ausência registrada" text="Registre férias e folgas para que as demandas novas sigam para o backup." size="compact" />
        : <ul className={styles.absences}>{data.absences.map((absence) => {
          const current = data.today >= absence.startsOn && data.today <= absence.endsOn;
          return <li key={absence.id}>
            <div><strong>{absence.userName}</strong><span>{formatDate(absence.startsOn)} a {formatDate(absence.endsOn)}{absence.reason ? ` · ${absence.reason}` : ""}</span>
              {current && <small className={styles.badge}>Ausente hoje</small>}</div>
            {canManage && <div className={styles.absenceActions}>
              <button type="button" className={styles.ghostButton} disabled={busy} onClick={() => void handOver(absence)}><UserRoundX aria-hidden="true" /> Passar abertas para o backup</button>
              <button type="button" className={styles.linkButton} disabled={busy} onClick={() => void removeAbsence(absence)}>Cancelar</button>
            </div>}
          </li>;
        })}</ul>}
    </section>

    <ConfirmDialog
      open={Boolean(pending)}
      eyebrow="Troca de carteira"
      title={pending ? `Carteira de ${pending.company.name}` : ""}
      consequence={pendingConsequence}
      confirmLabel="Confirmar troca"
      busy={busy}
      onCancel={() => setPending(null)}
      onConfirm={() => void confirmChange()}
    />
  </div>;
}
