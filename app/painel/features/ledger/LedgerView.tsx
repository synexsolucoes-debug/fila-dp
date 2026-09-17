"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight, HandCoins, Inbox, Info, ListChecks, Loader2, Plus, Send, ThumbsDown, ThumbsUp, Wallet, X,
} from "lucide-react";
import {
  formatBRL, formatCompetence, ledgerCategories, ledgerCategoryLabels,
  ledgerEntryStatusLabels, ledgerInstallmentStatusLabels,
} from "@/lib/payroll-ledger";
import type { LedgerEntryStatus, LedgerInstallmentStatus } from "@/lib/payroll-ledger";
import { EmptyState, ErrorBanner, LoadingState, PanelHeader, StatusPill } from "../shared/panel-ui";
import type { PanelTone } from "../shared/status-tone";
import { InstallmentActionDialog } from "./InstallmentActionDialog";
import { InstallmentsPanel, type InstallmentAction } from "./InstallmentsPanel";
import { LedgerEntryDialog, emptyDraft } from "./LedgerEntryDialog";
import {
  cancelEntry, confirmInstallment, createEntry, decideEntry, loadEmployees, loadEntries,
  loadEntryDetail, loadInstallments, loadOverview, renegotiateEntry, submitEntry, updateInstallment,
} from "./ledger.api";
import styles from "./ledger.module.css";
import type {
  LedgerEntry, LedgerEntryDetail, LedgerEntryDraft, LedgerInstallment, LedgerOverview,
  LedgerPersonOption,
} from "./ledger.types";

type Aba = "entries" | "installments";

function competenciaAtual() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Adiantamentos e Descontos.
 *
 * A tela responde, numa linha só por obrigação, o que a planilha só respondia
 * lendo oito abas: quem, de qual empresa e unidade, por quê, quanto no total,
 * em quantas parcelas, quanto já foi descontado e **quanto ainda falta**.
 *
 * Três coisas que esta tela deliberadamente não faz:
 *
 *  * não marca parcela como descontada. Confirmar desconto é outro controle,
 *    com permissão própria, e chega na etapa da conferência por competência;
 *  * não paga adiantamento. "Pago ao colaborador" e "descontado dele" são dois
 *    registros distintos do mesmo lançamento;
 *  * não desenha botão que ainda não faz nada. O que não está implementado não
 *    aparece.
 */
/* O tom sai do vocabulário compartilhado (`PanelTone`), e não de uma paleta
   própria: o mesmo verde de "concluído" precisa significar concluído em todas
   as telas do produto. */
const statusTone: Record<LedgerEntryStatus, PanelTone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "safe",
  rejected: "danger",
  active: "info",
  suspended: "warning",
  settled: "safe",
  canceled: "neutral",
  renegotiated: "neutral",
};

const installmentTone: Record<LedgerInstallmentStatus, PanelTone> = {
  scheduled: "neutral",
  partially_discounted: "warning",
  discounted: "safe",
  skipped: "warning",
  rescheduled: "warning",
  canceled: "neutral",
};

type Member = { id: string; name: string; email: string };

export function LedgerView({ members, currentUserId }: { members: Member[]; currentUserId: string }) {
  const [overview, setOverview] = useState<LedgerOverview | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [people, setPeople] = useState<LedgerPersonOption[]>([]);
  const [detail, setDetail] = useState<LedgerEntryDetail | null>(null);
  const [draft, setDraft] = useState<LedgerEntryDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");

  const [aba, setAba] = useState<Aba>("entries");
  const [installments, setInstallments] = useState<LedgerInstallment[]>([]);
  const [competence, setCompetence] = useState(competenciaAtual());
  const [overdue, setOverdue] = useState(false);
  const [installmentAction, setInstallmentAction] = useState<InstallmentAction | null>(null);
  const [actionError, setActionError] = useState("");
  const [renegotiation, setRenegotiation] = useState({ installmentCount: "", firstCompetence: "", reason: "" });

  const [companyId, setCompanyId] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [approver, setApprover] = useState("");
  const [decisionNote, setDecisionNote] = useState("");

  const filters = useMemo(
    () => ({ companyId, employeeId: "", category, status, requesterAreaId: "", openOnly }),
    [companyId, category, status, openOnly],
  );

  /* Nenhum `setState` antes do primeiro `await`: chamado de dentro de um efeito,
     um deles dispararia render em cascata — e o efeito é justamente quem carrega
     a tela pela primeira vez. */
  const refresh = useCallback(async () => {
    try {
      const [head, list] = await Promise.all([loadOverview(companyId), loadEntries(filters)]);
      setError("");
      setOverview(head);
      setEntries(list.entries);
      setTruncated(list.truncated);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Não foi possível carregar os lançamentos.");
    }
  }, [companyId, filters]);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        await refresh();
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => { vivo = false; };
  }, [refresh]);

  /* As parcelas só são buscadas quando a aba delas está aberta: a conferência
     de uma competência traz milhares de linhas, e carregá-las junto da lista de
     lançamentos custaria isso a cada visita, inclusive às que não abrem a aba. */
  const refreshInstallments = useCallback(async () => {
    const dados = await loadInstallments({
      companyId, competence, overdue, category, status: "", settlementTarget: "",
    });
    setInstallments(dados.installments);
  }, [companyId, competence, overdue, category]);

  useEffect(() => {
    if (aba !== "installments") return;
    let vivo = true;
    void (async () => {
      try {
        await refreshInstallments();
      } catch (issue) {
        if (vivo) setError(issue instanceof Error ? issue.message : "Não foi possível carregar as parcelas.");
      }
    })();
    return () => { vivo = false; };
  }, [aba, refreshInstallments]);

  /* O seletor de pessoas só é carregado quando o formulário abre e uma empresa
     está escolhida: buscar todos os colaboradores do grupo ao abrir a tela
     seria um download que 90% das visitas não usa. */
  useEffect(() => {
    /* Sem empresa escolhida, `loadEmployees` já devolve lista vazia sem ir ao
       servidor. Deixar a resposta sempre passar pelo callback evita o
       `setState` síncrono dentro do efeito, que dispara render em cascata. */
    let ativo = true;
    void loadEmployees(draft?.companyId ?? "")
      .then((list) => { if (ativo) setPeople(list); })
      .catch(() => { if (ativo) setPeople([]); });
    return () => { ativo = false; };
  }, [draft?.companyId]);

  const openDetail = useCallback(async (id: string) => {
    setBusy(true); setError(""); setApprover(""); setDecisionNote("");
    try {
      setDetail(await loadEntryDetail(id));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Não foi possível abrir o lançamento.");
    } finally {
      setBusy(false);
    }
  }, []);

  const run = useCallback(async (action: () => Promise<unknown>, afterDetailId?: string) => {
    setBusy(true); setError("");
    try {
      await action();
      await refresh();
      if (afterDetailId) setDetail(await loadEntryDetail(afterDetailId));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Não foi possível concluir a operação.");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter((entry) =>
      entry.employeeName.toLowerCase().includes(term)
      || entry.providerName.toLowerCase().includes(term)
      || entry.title.toLowerCase().includes(term)
      || entry.registrationNumber.toLowerCase().includes(term));
  }, [entries, search]);

  if (loading) return <LoadingState title="Carregando adiantamentos e descontos" />;

  const permissions = overview?.permissions;
  const summary = overview?.summary;
  const approvers = members.filter((member) => member.id !== currentUserId);

  return (
    <section className={styles.workspace}>
      <PanelHeader
        eyebrow="OPERAÇÃO DO DP"
        title="Adiantamentos e Descontos"
        description="Um registro por obrigação, com parcelas, saldo e histórico. O produto organiza o desconto; quem calcula o salário continua sendo a folha."
        action={permissions?.manage ? (
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => { setFormError(""); setDraft(emptyDraft(companyId)); }}
          >
            <Plus aria-hidden="true" /> Novo lançamento
          </button>
        ) : undefined}
      />

      {error && <ErrorBanner title="Não foi possível concluir" message={error} onDismiss={() => setError("")} />}

      {summary && (
        <div className={styles.metrics}>
          <article>
            <HandCoins aria-hidden="true" />
            <span>Lançamentos ativos</span>
            <strong>{summary.entries}</strong>
            <small>{summary.awaitingApproval} aguardando aprovação</small>
          </article>
          <article>
            <span>Programado</span>
            <strong>{formatBRL(summary.plannedTotal)}</strong>
            <small>Soma das parcelas que continuam valendo</small>
          </article>
          <article>
            <span>Já descontado</span>
            <strong>{formatBRL(summary.discountedTotal)}</strong>
            <small>Somente o que foi confirmado</small>
          </article>
          <article>
            <span>Saldo a descontar</span>
            <strong>{formatBRL(summary.remainingTotal)}</strong>
            <small>O número que a planilha não respondia</small>
          </article>
        </div>
      )}

      <nav className={styles.localTabs} aria-label="Áreas do módulo">
        <button type="button" aria-current={aba === "entries" ? "page" : undefined} onClick={() => setAba("entries")}>
          <ListChecks aria-hidden="true" /> Lançamentos
        </button>
        <button type="button" aria-current={aba === "installments" ? "page" : undefined} onClick={() => setAba("installments")}>
          <Wallet aria-hidden="true" /> Parcelas e saldos
        </button>
      </nav>

      <div className={styles.filters}>
        <label>
          Empresa
          <select value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
            <option value="">Todas</option>
            {(overview?.companies ?? []).map((company) => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
        </label>
        <label>
          Categoria
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">Todas</option>
            {ledgerCategories.map((item) => (
              <option key={item} value={item}>{ledgerCategoryLabels[item]}</option>
            ))}
          </select>
        </label>
        <label>
          Situação
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todas</option>
            {(Object.keys(ledgerEntryStatusLabels) as LedgerEntryStatus[]).map((item) => (
              <option key={item} value={item}>{ledgerEntryStatusLabels[item]}</option>
            ))}
          </select>
        </label>
        {aba === "entries" ? (
          <>
            <label>
              Buscar
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Nome, matrícula ou descrição"
                aria-label="Buscar por nome, matrícula ou descrição"
              />
            </label>
            <label className={styles.checkboxFilter}>
              <input type="checkbox" checked={openOnly} onChange={(event) => setOpenOnly(event.target.checked)} />
              Somente com saldo em aberto
            </label>
          </>
        ) : (
          <>
            <label>
              Competência
              <input value={competence} onChange={(event) => setCompetence(event.target.value)} placeholder="2026-09" />
            </label>
            {/* Parcela atrasada continua pertencendo ao mês em que nasceu: este
                filtro é leitura, não migração para o mês atual. */}
            <label className={styles.checkboxFilter}>
              <input type="checkbox" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} />
              Pendentes de competências anteriores
            </label>
          </>
        )}
      </div>

      {aba === "installments" ? (
        <InstallmentsPanel
          installments={installments}
          permissions={permissions}
          busy={busy}
          onAction={(action) => { setActionError(""); setInstallmentAction(action); }}
        />
      ) : (
        <>
      <div className={styles.tableTools}>
        <span>{visible.length} lançamento(s)</span>
        {truncated && <span>A consulta atingiu o limite. Reduza o recorte para ver tudo.</span>}
      </div>

      {visible.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>Empresa / unidade</th>
                <th>Categoria</th>
                <th>Parcelas</th>
                <th className={styles.amount}>Total</th>
                <th className={styles.amount}>Descontado</th>
                <th className={styles.amount}>Saldo</th>
                <th>Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="Pessoa">
                    <strong>{entry.employeeName || entry.providerName || "—"}</strong>
                    <small>
                      {entry.registrationNumber ? `Matrícula ${entry.registrationNumber}` : entry.providerName ? "Prestador PJ" : ""}
                      {entry.departmentLabel ? ` · ${entry.departmentLabel}` : ""}
                    </small>
                  </td>
                  <td data-label="Empresa / unidade">
                    <strong>{entry.companyName}</strong>
                    <small>{entry.unitLabel || "—"}</small>
                  </td>
                  <td data-label="Categoria">
                    <strong>{ledgerCategoryLabels[entry.category]}</strong>
                    <small>{entry.title}</small>
                  </td>
                  <td data-label="Parcelas">
                    {entry.modality === "recurring"
                      ? <><strong>Recorrente</strong><small>desde {formatCompetence(entry.firstCompetence)}</small></>
                      : <><strong>{entry.installmentCount ?? 1}×</strong><small>a partir de {formatCompetence(entry.firstCompetence)}</small></>}
                  </td>
                  <td data-label="Total" className={styles.amount}>
                    {entry.totalAmount === null ? "—" : formatBRL(entry.totalAmount)}
                  </td>
                  <td data-label="Descontado" className={styles.amount}>{formatBRL(entry.discountedAmount)}</td>
                  <td data-label="Saldo" className={styles.amount}>
                    {entry.modality === "recurring" && entry.totalAmount === null
                      ? "—"
                      : formatBRL(entry.remainingAmount)}
                  </td>
                  <td data-label="Situação">
                    <StatusPill
                      status={entry.status}
                      label={ledgerEntryStatusLabels[entry.status]}
                      tone={statusTone[entry.status]}
                    />
                  </td>
                  <td>
                    <button type="button" className={styles.rowAction} onClick={() => void openDetail(entry.id)}>
                      Abrir <ChevronRight aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={Inbox}
          title="Nenhum lançamento neste recorte"
          text="Adiantamentos, empréstimos, multas, franquias e descontos do SESMT aparecem aqui, cada um com o próprio saldo."
          action={permissions?.manage ? (
            <button type="button" className={styles.secondaryButton} onClick={() => { setFormError(""); setDraft(emptyDraft(companyId)); }}>
              <Plus aria-hidden="true" /> Criar o primeiro
            </button>
          ) : undefined}
        />
      )}
        </>
      )}

      {installmentAction && (
        <InstallmentActionDialog
          action={installmentAction}
          busy={busy}
          error={actionError}
          onCancel={() => { setInstallmentAction(null); setActionError(""); }}
          onSubmit={(payload) => {
            const alvo = installmentAction;
            setBusy(true); setActionError("");
            const pedido = alvo.kind === "reschedule" || alvo.kind === "skip"
              ? updateInstallment(alvo.installment.id, {
                action: alvo.kind,
                competence: alvo.kind === "reschedule" ? payload.competence : undefined,
                justification: payload.justification,
              })
              : confirmInstallment(alvo.installment.id, {
                kind: alvo.kind === "confirm" ? "confirmation" : alvo.kind === "override" ? "authorized_override" : "reversal",
                amount: payload.amount,
                competence: payload.competence,
                justification: payload.justification,
                reference: payload.reference,
              });
            void pedido
              .then(async () => {
                setInstallmentAction(null);
                await Promise.all([refresh(), refreshInstallments()]);
              })
              .catch((issue: unknown) => setActionError(issue instanceof Error ? issue.message : "Não foi possível concluir a operação."))
              .finally(() => setBusy(false));
          }}
        />
      )}

      {draft && (
        <LedgerEntryDialog
          draft={draft}
          companies={overview?.companies ?? []}
          people={people}
          areas={overview?.areas ?? []}
          busy={busy}
          error={formError}
          onChange={setDraft}
          onCancel={() => { setDraft(null); setFormError(""); }}
          onSubmit={() => {
            setBusy(true); setFormError("");
            void createEntry(draft)
              .then(async () => { setDraft(null); await refresh(); })
              .catch((issue: unknown) => setFormError(issue instanceof Error ? issue.message : "Não foi possível criar o lançamento."))
              .finally(() => setBusy(false));
          }}
        />
      )}

      {detail && (
        <div className={styles.drawerBackdrop} role="dialog" aria-modal="true" aria-label={detail.entry.title}>
          <div className={styles.drawer}>
            <div className={styles.drawerHead}>
              <div>
                <h2>{detail.entry.title}</h2>
                <p>
                  {detail.entry.employeeName || detail.entry.providerName} · {ledgerCategoryLabels[detail.entry.category]}
                  {detail.entry.requesterAreaName ? ` · solicitado por ${detail.entry.requesterAreaName}` : ""}
                </p>
              </div>
              <button type="button" className={styles.closeButton} onClick={() => setDetail(null)} aria-label="Fechar">
                <X aria-hidden="true" />
              </button>
            </div>

            <dl className={styles.definitionList}>
              <div>
                <dt>Situação</dt>
                <dd>{ledgerEntryStatusLabels[detail.entry.status]}</dd>
              </div>
              <div>
                <dt>Valor total</dt>
                <dd>{detail.entry.totalAmount === null ? "Sem total (recorrente)" : formatBRL(detail.entry.totalAmount)}</dd>
              </div>
              <div>
                <dt>Já descontado</dt>
                <dd>{formatBRL(detail.entry.discountedAmount)}</dd>
              </div>
              <div>
                <dt>Saldo</dt>
                <dd>{detail.entry.totalAmount === null ? "—" : formatBRL(detail.entry.remainingAmount)}</dd>
              </div>
            </dl>

            {detail.entry.reason && (
              <p className={styles.notice}>{detail.entry.reason}</p>
            )}

            {permissions?.request && (detail.entry.status === "draft" || detail.entry.status === "rejected") && (
              <div className={styles.formGrid}>
                <label className={styles.fullWidth}>
                  Enviar para aprovação de
                  <select value={approver} onChange={(event) => setApprover(event.target.value)}>
                    <option value="">Selecione quem aprova</option>
                    {approvers.map((member) => (
                      <option key={member.id} value={member.id}>{member.name}</option>
                    ))}
                  </select>
                  <span className={styles.fieldHint}>Quem solicita não aprova o próprio lançamento.</span>
                </label>
                <div className={`${styles.fullWidth} ${styles.formActions}`}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={busy || !approver}
                    onClick={() => void run(() => submitEntry(detail.entry.id, approver), detail.entry.id)}
                  >
                    {busy ? <Loader2 aria-hidden="true" className={styles.spin} /> : <Send aria-hidden="true" />}
                    Enviar para aprovação
                  </button>
                </div>
              </div>
            )}

            {permissions?.approve && detail.entry.status === "pending_approval" && (
              <div className={styles.formGrid}>
                <label className={styles.fullWidth}>
                  Justificativa da decisão
                  <textarea
                    value={decisionNote}
                    onChange={(event) => setDecisionNote(event.target.value)}
                    maxLength={1000}
                    placeholder="Obrigatória na recusa."
                  />
                </label>
                <div className={`${styles.fullWidth} ${styles.formActions}`}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={busy || decisionNote.trim().length < 5}
                    onClick={() => void run(() => decideEntry(detail.entry.id, "reject", decisionNote), detail.entry.id)}
                  >
                    <ThumbsDown aria-hidden="true" /> Recusar
                  </button>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={busy}
                    onClick={() => void run(() => decideEntry(detail.entry.id, "approve", decisionNote), detail.entry.id)}
                  >
                    <ThumbsUp aria-hidden="true" /> Aprovar
                  </button>
                </div>
                <p className={`${styles.fullWidth} ${styles.notice}`}>
                  Aprovar autoriza o desconto. Não paga adiantamento e não baixa parcela — esses são controles à parte.
                </p>
              </div>
            )}

            <p className={styles.sectionTitle}>Parcelas</p>
            {detail.installments.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>Parcela</th>
                      <th>Competência</th>
                      <th className={styles.amount}>Previsto</th>
                      <th className={styles.amount}>Descontado</th>
                      <th className={styles.amount}>Saldo</th>
                      <th>Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.installments.map((part) => (
                      <tr key={part.id}>
                        <td data-label="Parcela">{part.number}{part.totalCount ? `/${part.totalCount}` : ""}</td>
                        <td data-label="Competência">{formatCompetence(part.competence)}</td>
                        <td data-label="Previsto" className={styles.amount}>{formatBRL(part.plannedAmount)}</td>
                        <td data-label="Descontado" className={styles.amount}>{formatBRL(part.discountedAmount)}</td>
                        <td data-label="Saldo" className={styles.amount}>{formatBRL(part.remainingAmount)}</td>
                        <td data-label="Situação">
                          <StatusPill
                            status={part.status}
                            label={ledgerInstallmentStatusLabels[part.status]}
                            tone={installmentTone[part.status]}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={styles.notice}>
                Lançamento recorrente: as ocorrências nascem competência a competência, na conferência do mês.
              </p>
            )}

            {detail.confirmations.length > 0 && (
              <>
                <p className={styles.sectionTitle}>Confirmações e estornos</p>
                <ul className={styles.timeline}>
                  {detail.confirmations.map((confirmation) => (
                    <li key={confirmation.id}>
                      <strong>
                        {confirmation.kind === "reversal" ? "Estorno" : confirmation.kind === "authorized_override" ? "Ajuste autorizado" : "Desconto confirmado"}
                        {" · "}{formatBRL(Math.abs(confirmation.amount))} em {formatCompetence(confirmation.competence)}
                      </strong>
                      {confirmation.justification && <span>{confirmation.justification}</span>}
                      <time>{confirmation.confirmedByName || confirmation.confirmedBy} · {confirmation.confirmedAt.slice(0, 10)}</time>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <p className={styles.sectionTitle}>Histórico</p>
            <ul className={styles.timeline}>
              {detail.events.map((event) => (
                <li key={event.id}>
                  <strong>{event.summary || event.eventType}</strong>
                  <time>{event.actorName || "Sistema"} · {event.createdAt.slice(0, 10)}</time>
                </li>
              ))}
            </ul>

            {permissions?.manage && detail.entry.modality !== "recurring"
              && ["approved", "active", "suspended"].includes(detail.entry.status)
              && detail.entry.remainingAmount > 0 && (
              <>
                <p className={styles.sectionTitle}>Renegociar o saldo</p>
                <p className={styles.notice}>
                  <Info aria-hidden="true" />
                  <span>
                    Renegociar cria um acordo novo, cobrindo <strong>somente os {formatBRL(detail.entry.remainingAmount)}</strong> que
                    ainda faltam. O acordo original fica no histórico com o valor e as parcelas que já foram descontadas — ele não é reescrito.
                  </span>
                </p>
                <div className={styles.formGrid}>
                  <label>
                    Em quantas parcelas
                    <input value={renegotiation.installmentCount} onChange={(event) => setRenegotiation({ ...renegotiation, installmentCount: event.target.value })} inputMode="numeric" placeholder="6" />
                  </label>
                  <label>
                    A partir da competência
                    <input value={renegotiation.firstCompetence} onChange={(event) => setRenegotiation({ ...renegotiation, firstCompetence: event.target.value })} placeholder="2026-12" />
                  </label>
                  <label className={styles.fullWidth}>
                    Motivo da renegociação
                    <textarea value={renegotiation.reason} onChange={(event) => setRenegotiation({ ...renegotiation, reason: event.target.value })} maxLength={1000} />
                  </label>
                  <div className={`${styles.fullWidth} ${styles.formActions}`}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy || !renegotiation.installmentCount || !renegotiation.firstCompetence || renegotiation.reason.trim().length < 5}
                      onClick={() => void run(async () => {
                        await renegotiateEntry(detail.entry.id, renegotiation);
                        setDetail(null);
                        setRenegotiation({ installmentCount: "", firstCompetence: "", reason: "" });
                      })}
                    >
                      Renegociar saldo
                    </button>
                  </div>
                </div>
              </>
            )}

            {permissions?.manage && detail.entry.status === "draft" && detail.entry.discountedAmount === 0 && (
              <div className={styles.formActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy}
                  onClick={() => {
                    const motivo = window.prompt("Motivo do cancelamento (mínimo 5 caracteres):") ?? "";
                    if (motivo.trim().length < 5) return;
                    void run(() => cancelEntry(detail.entry.id, motivo), detail.entry.id);
                  }}
                >
                  Cancelar lançamento
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
