"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCheck, ClipboardCheck, Download, Eye, FileSpreadsheet, FileUp, Filter, RefreshCw, Search, X,
} from "lucide-react";
import {
  invoiceQuickFilterLabels,
  invoiceQuickFilters,
  invoiceRejectionReasonLabels,
  invoiceRejectionReasons,
  invoiceReviewStatusLabels,
  matchesQuickFilter,
  type InvoiceQuickFilter,
} from "@/lib/contractor-invoices";
import { ConfirmDialog, EmptyState, ErrorBanner, PageSkeleton } from "../shared";
import { InvoiceReviewDrawer } from "./InvoiceReviewDrawer";
import { InvoiceUploadDialog } from "./InvoiceUploadDialog";
import { normalizeInvoiceDetail, normalizeInvoicePanel, requestJson, type Row } from "./payments.api";
import type { InvoiceDetail, InvoicePanel, InvoiceRow } from "./payments.types";
import styles from "./payments.module.css";

/**
 * Notas Fiscais da competência.
 *
 * A tela responde, na ordem em que se pergunta: quantos precisam emitir, quem
 * já mandou, o que trava o pagamento, e — clicando — a nota em si.
 *
 * Os indicadores do topo não são decoração: cada um é o filtro do seu próprio
 * número. "7 pendentes" que não leva aos sete é um número que obriga a
 * procurá-los na tabela, e procurar na tabela é o trabalho que a tela existe
 * para tirar.
 *
 * Os filtros são aplicados no navegador, sobre a competência inteira já
 * carregada. Uma competência PJ tem dezenas de linhas, não milhares: filtrar
 * no servidor custaria uma ida ao banco por clique de filtro rápido para
 * ganhar nada.
 */

const digits = (value: string) => value.replace(/\D/gu, "");

/** Situação do pagamento em linguagem da tela de pagamentos. */
const closingStatusLabels: Record<string, string> = {
  open: "Aberto", review: "Conferência", approval: "Aprovação", approved: "Aprovado",
  invoice_pending: "Aguardando nota", ready_to_pay: "Pronto para pagar", paid: "Pago",
  closed: "Fechado", reopened: "Reaberto",
};

type Filters = {
  search: string;
  reviewStatus: string;
  closingStatus: string;
  reviewer: string;
  issuedFrom: string;
  issuedTo: string;
  receivedFrom: string;
  receivedTo: string;
  minAmount: string;
  maxAmount: string;
};

const emptyFilters: Filters = {
  search: "", reviewStatus: "", closingStatus: "", reviewer: "",
  issuedFrom: "", issuedTo: "", receivedFrom: "", receivedTo: "", minAmount: "", maxAmount: "",
};

export function ContractorInvoicesSection({ companyId, competence, competenceLabel, money, reportUrl }: {
  companyId: string;
  competence: string;
  competenceLabel: (value: string) => string;
  money: (value: number) => string;
  reportUrl: (report: string, format?: "csv" | "pdf") => string;
}) {
  const [panel, setPanel] = useState<InvoicePanel | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const [quick, setQuick] = useState<InvoiceQuickFilter>("all");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [uploadRow, setUploadRow] = useState<InvoiceRow | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState("");

  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [detailId, setDetailId] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [batch, setBatch] = useState<null | { action: "start_review" | "approve" | "request_correction" }>(null);
  const [batchReason, setBatchReason] = useState<string>(invoiceRejectionReasons[0]);
  const [batchDetail, setBatchDetail] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (!companyId) return;
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const params = new URLSearchParams({ companyId, competence });
      const payload = await requestJson<Row>(`/api/payments/contractors/invoices?${params}`);
      setPanel(normalizeInvoicePanel(payload));
      // A seleção é de linhas desta competência: mantê-la ao trocar de
      // competência aplicaria uma ação em lote sobre notas que saíram da tela.
      setSelected(new Set());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar as notas fiscais.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [companyId, competence]);

  /* O quadro adiado é a convenção do painel para disparar carga a partir de um
     efeito sem encadear renderizações — a mesma usada em `PaymentsView`. */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const rows = useMemo(() => panel?.rows ?? [], [panel?.rows]);
  const policy = panel?.policy.reviewPolicy ?? "required";
  const permissions = panel?.permissions;
  const archivedDocuments = rows.filter((row) => Boolean(row.documentId)).length;
  const archiveUrl = `/api/payments/contractors/invoices/archive?companyId=${encodeURIComponent(companyId)}&competence=${encodeURIComponent(competence)}`;

  const visible = useMemo(() => rows.filter((row) => {
    if (!matchesQuickFilter(row, quick, policy)) return false;
    if (filters.reviewStatus && row.reviewStatus !== filters.reviewStatus) return false;
    if (filters.closingStatus && row.closingStatus !== filters.closingStatus) return false;
    if (filters.reviewer && row.reviewedByUserId !== filters.reviewer) return false;
    if (filters.issuedFrom && (!row.issueDate || row.issueDate < filters.issuedFrom)) return false;
    if (filters.issuedTo && (!row.issueDate || row.issueDate > filters.issuedTo)) return false;
    if (filters.receivedFrom && row.uploadedAt.slice(0, 10) < filters.receivedFrom) return false;
    if (filters.receivedTo && (!row.uploadedAt || row.uploadedAt.slice(0, 10) > filters.receivedTo)) return false;
    const minimum = Number(filters.minAmount);
    const maximum = Number(filters.maxAmount);
    if (filters.minAmount && Number.isFinite(minimum) && row.expectedAmount < minimum) return false;
    if (filters.maxAmount && Number.isFinite(maximum) && row.expectedAmount > maximum) return false;
    const term = filters.search.trim().toLowerCase();
    if (!term) return true;
    // A busca por documento compara só dígitos: quem cola um CNPJ traz a
    // pontuação junto, e o cadastro pode tê-la gravado de outro jeito.
    const numeric = digits(term);
    return [row.providerName, row.providerTradeName, row.invoiceNumber, row.contractReference]
      .some((value) => value.toLowerCase().includes(term))
      || (numeric.length >= 3 && [row.providerDocument, row.issuerDocument].some((value) => digits(value).includes(numeric)));
  }), [filters, policy, quick, rows]);

  const selectable = useMemo(
    () => visible.filter((row) => row.hasInvoice && row.reviewStatus !== "approved"),
    [visible],
  );
  const selectedRows = useMemo(() => {
    const available = new Map(selectable.map((row) => [row.invoiceId, row]));
    return [...selected].map((id) => available.get(id)).filter((row): row is InvoiceRow => Boolean(row));
  }, [selectable, selected]);
  const allSelected = selectable.length > 0 && selectedRows.length === selectable.length;

  const activeFilters = Object.entries(filters).filter(([, value]) => value !== "").length;

  const openDetail = useCallback(async (invoiceId: string) => {
    setDetailId(invoiceId);
    setDetailLoading(true);
    setDetailError("");
    try {
      const payload = await requestJson<Row>(`/api/payments/contractors/invoices/${invoiceId}`);
      setDetail(normalizeInvoiceDetail(payload));
    } catch (cause) {
      setDetail(null);
      setDetailId("");
      setError(cause instanceof Error ? cause.message : "Não foi possível abrir a nota fiscal.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  async function submitUpload(form: FormData, confirmDuplicate: boolean) {
    if (!uploadRow) return;
    setBusy(true);
    setUploadError("");
    form.set("closingId", uploadRow.closingId);
    if (uploadRow.invoiceId) form.set("replacesInvoiceId", uploadRow.invoiceId);
    if (confirmDuplicate) form.set("confirmDuplicate", "true");
    try {
      await requestJson("/api/payments/contractors/invoices", { method: "POST", body: form });
      setUploadRow(null);
      setDuplicateWarning("");
      setToast("Nota fiscal registrada e enviada para conferência.");
      await load(true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Não foi possível registrar a nota.";
      // A duplicidade não é erro de preenchimento: ela vira um aviso dentro da
      // própria janela, com a confirmação ao lado, para quem pode confirmar.
      if (message.startsWith("Possível nota fiscal duplicada")) {
        setDuplicateWarning(message);
        setUploadError("");
      } else {
        setUploadError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitReview(input: { action: string; checklist: Record<string, boolean>; note: string; reason: string; reasonDetail: string }) {
    if (!detail) return;
    setBusy(true);
    setDetailError("");
    try {
      await requestJson(`/api/payments/contractors/invoices/${detail.invoice.id}/review`, {
        method: "POST",
        body: JSON.stringify({
          action: input.action, checklist: input.checklist, note: input.note,
          reason: input.reason, reasonDetail: input.reasonDetail,
        }),
      });
      setToast(input.action === "approve" ? "Nota aprovada. O pagamento foi liberado." : "Decisão registrada no histórico da nota.");
      await Promise.all([load(true), openDetail(detail.invoice.id)]);
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : "Não foi possível registrar a decisão.");
    } finally {
      setBusy(false);
    }
  }

  async function submitBatch() {
    if (!batch) return;
    setBusy(true);
    try {
      const payload = await requestJson<{ appliedCount: number; failedCount: number; failed: { message: string }[] }>(
        "/api/payments/contractors/invoices/batch",
        {
          method: "POST",
          body: JSON.stringify({
            action: batch.action,
            invoiceIds: selectedRows.map((row) => row.invoiceId),
            confirm: true,
            reason: batch.action === "request_correction" ? batchReason : undefined,
            reasonDetail: batch.action === "request_correction" ? batchDetail : undefined,
          }),
        },
      );
      setBatch(null);
      setSelected(new Set());
      setToast(payload.failedCount === 0
        ? `${payload.appliedCount} nota(s) atualizada(s).`
        : `${payload.appliedCount} nota(s) atualizada(s); ${payload.failedCount} não puderam ser aplicadas.`);
      if (payload.failedCount > 0 && payload.failed[0]) setError(payload.failed[0].message);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível aplicar a ação em lote.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageSkeleton label="Carregando as notas fiscais da competência" rows={6} metrics={4} />;
  if (!panel) return <ErrorBanner message={error || "Não foi possível carregar as notas fiscais."} />;

  const summary = panel.summary;
  const alerts = [
    summary.pendingCount > 0 && `${summary.pendingCount} prestador(es) ainda não enviaram nota fiscal.`,
    summary.awaitingReviewCount > 0 && `${summary.awaitingReviewCount} nota(s) aguardam conferência.`,
    summary.divergentCount > 0 && `${summary.divergentCount} nota(s) com divergência de valor.`,
    summary.rejectedCount + summary.correctionCount > 0
      && `${summary.rejectedCount + summary.correctionCount} nota(s) precisam ser substituídas.`,
  ].filter((item): item is string => typeof item === "string");

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

      {/* Cada indicador é o filtro do seu próprio número (§3). */}
      <div className={styles.summaryGrid}>
        <IndicatorCard label="Precisam emitir NF" value={summary.requiredCount} onClick={() => setQuick("all")} active={quick === "all"} />
        <IndicatorCard label="Notas recebidas" value={summary.receivedCount} onClick={() => setQuick("received")} active={quick === "received"} />
        <IndicatorCard label="Pendentes" value={summary.pendingCount} onClick={() => setQuick("missing")} active={quick === "missing"} alert={summary.pendingCount > 0} />
        <IndicatorCard label="Aguardando conferência" value={summary.awaitingReviewCount} onClick={() => setQuick("awaiting_review")} active={quick === "awaiting_review"} />
        <IndicatorCard label="Aprovadas" value={summary.approvedCount} onClick={() => setQuick("approved")} active={quick === "approved"} />
        <IndicatorCard label="Rejeitadas" value={summary.rejectedCount + summary.correctionCount} onClick={() => setQuick("rejected")} active={quick === "rejected"} alert={summary.rejectedCount + summary.correctionCount > 0} />
        <IndicatorCard label="Valor total previsto" value={money(summary.expectedAmount)} onClick={() => setQuick("all")} active={false} />
        <IndicatorCard label="Coberto por NF aprovada" value={money(summary.approvedAmount)} onClick={() => setQuick("approved")} active={quick === "approved"} />
      </div>

      <section className={styles.invoiceProgress} aria-labelledby="invoice-progress-title">
        <div>
          <span className={styles.eyebrow}>ANDAMENTO DA CONFERÊNCIA</span>
          <h3 id="invoice-progress-title">
            Notas Fiscais: {summary.approvedCount}/{summary.requiredCount} aprovadas
          </h3>
          <p>{summary.progress}% concluído em {competenceLabel(competence)}. O progresso considera apenas quem é obrigado a emitir nota.</p>
        </div>
        <div className={styles.invoiceProgressBar}
          role="progressbar" aria-valuenow={summary.progress} aria-valuemin={0} aria-valuemax={100}
          aria-label="Conferência de notas fiscais concluída">
          <span style={{ width: `${summary.progress}%` }} />
        </div>
      </section>

      {alerts.length > 0 && (
        <ul className={styles.invoiceAlerts}>
          {alerts.map((alert) => <li key={alert}>{alert}</li>)}
        </ul>
      )}

      <div className={styles.invoiceToolbar}>
        <div className={styles.invoiceQuickFilters} role="group" aria-label="Filtros rápidos">
          {invoiceQuickFilters.map((filter) => (
            <button key={filter} type="button" data-active={quick === filter ? "true" : "false"}
              onClick={() => setQuick(filter)}>
              {invoiceQuickFilterLabels[filter]}
            </button>
          ))}
        </div>
        <div className={styles.invoiceToolbarActions}>
          <label className={styles.invoiceSearch}>
            <Search aria-hidden="true" />
            <input value={filters.search} placeholder="Nome, razão social, CPF/CNPJ ou número da NF"
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              aria-label="Buscar prestador ou nota" />
            {filters.search && (
              <button type="button" onClick={() => setFilters((current) => ({ ...current, search: "" }))} aria-label="Limpar busca">
                <X aria-hidden="true" />
              </button>
            )}
          </label>
          <button type="button" className={styles.secondaryButton} onClick={() => setFiltersOpen((current) => !current)}
            aria-expanded={filtersOpen}>
            <Filter aria-hidden="true" /> Filtros{activeFilters > 0 ? ` (${activeFilters})` : ""}
          </button>
          <button type="button" className={styles.secondaryButton} onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw aria-hidden="true" /> {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      </div>

      {filtersOpen && (
        <div className={styles.invoiceFilters}>
          <label>Situação da nota
            <select value={filters.reviewStatus} onChange={(event) => setFilters((current) => ({ ...current, reviewStatus: event.target.value }))}>
              <option value="">Todas</option>
              {Object.entries(invoiceReviewStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>Situação do pagamento
            <select value={filters.closingStatus} onChange={(event) => setFilters((current) => ({ ...current, closingStatus: event.target.value }))}>
              <option value="">Todas</option>
              {Object.entries(closingStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>Responsável pela conferência
            <select value={filters.reviewer} onChange={(event) => setFilters((current) => ({ ...current, reviewer: event.target.value }))}>
              <option value="">Todos</option>
              {panel.reviewers.map((reviewer) => (
                <option key={reviewer.id} value={reviewer.id}>{reviewer.name || reviewer.id}</option>
              ))}
            </select>
          </label>
          <label>Emissão de
            <input type="date" value={filters.issuedFrom} onChange={(event) => setFilters((current) => ({ ...current, issuedFrom: event.target.value }))} />
          </label>
          <label>Emissão até
            <input type="date" value={filters.issuedTo} onChange={(event) => setFilters((current) => ({ ...current, issuedTo: event.target.value }))} />
          </label>
          <label>Recebimento de
            <input type="date" value={filters.receivedFrom} onChange={(event) => setFilters((current) => ({ ...current, receivedFrom: event.target.value }))} />
          </label>
          <label>Recebimento até
            <input type="date" value={filters.receivedTo} onChange={(event) => setFilters((current) => ({ ...current, receivedTo: event.target.value }))} />
          </label>
          <label>Valor previsto de
            <input type="number" min="0" step="0.01" value={filters.minAmount}
              onChange={(event) => setFilters((current) => ({ ...current, minAmount: event.target.value }))} />
          </label>
          <label>Valor previsto até
            <input type="number" min="0" step="0.01" value={filters.maxAmount}
              onChange={(event) => setFilters((current) => ({ ...current, maxAmount: event.target.value }))} />
          </label>
          <div className={styles.invoiceFiltersFooter}>
            <button type="button" className={styles.secondaryButton} onClick={() => setFilters({ ...emptyFilters, search: filters.search })}>
              Limpar filtros
            </button>
          </div>
        </div>
      )}

      {selectedRows.length > 0 && (permissions?.review || permissions?.approve || permissions?.reject) && (
        <div className={styles.invoiceBatchBar} role="region" aria-label="Ações em lote">
          <span>{selectedRows.length} nota(s) selecionada(s)</span>
          {permissions?.review && (
            <button type="button" className={styles.secondaryButton} disabled={busy}
              onClick={() => setBatch({ action: "start_review" })}>
              <ClipboardCheck aria-hidden="true" /> Marcar para conferência
            </button>
          )}
          {permissions?.reject && (
            <button type="button" className={styles.secondaryButton} disabled={busy}
              onClick={() => setBatch({ action: "request_correction" })}>
              Solicitar correção
            </button>
          )}
          {permissions?.approve && (
            <button type="button" className={styles.primaryButton} disabled={busy}
              onClick={() => setBatch({ action: "approve" })}>
              <CheckCheck aria-hidden="true" /> Aprovar selecionadas
            </button>
          )}
          <button type="button" className={styles.secondaryButton} onClick={() => setSelected(new Set())}>Limpar seleção</button>
        </div>
      )}

      {/* Nenhuma nota recebida ainda não é uma tela vazia: os prestadores que
          precisam emitir estão todos ali, e é na linha deles que se anexa a
          nota quando ela chega. Trocar a tabela por um aviso tiraria justamente
          a ação que o aviso manda executar. */}
      {summary.requiredCount > 0 && summary.receivedCount === 0 && (
        <p className={styles.invoiceEmptyNotice}>
          <FileUp aria-hidden="true" />
          <span>
            <strong>Nenhuma Nota Fiscal recebida</strong>
            Existem {summary.requiredCount} prestador(es) aguardando envio de Nota Fiscal em
            {" "}{competenceLabel(competence)}. Anexe a nota pela ação na linha do prestador assim que ela chegar.
          </span>
        </p>
      )}

      {rows.length === 0 || summary.requiredCount === 0 ? (
        <EmptyState
          icon={FileUp}
          title="Nenhuma Nota Fiscal necessária nesta competência"
          text={`Nenhum prestador tem valor de nota apurado em ${competenceLabel(competence)}. Apure a competência em Pagamentos para que as notas exigidas apareçam aqui.`}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Nenhuma nota nesse recorte"
          text="Os filtros aplicados não encontraram notas nesta competência. Ajuste os filtros ou volte para “Todas”."
        />
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>Notas fiscais de {competenceLabel(competence)}</caption>
            <thead>
              <tr>
                <th scope="col" className={styles.invoiceSelectCell}>
                  {selectable.length > 0 && (
                    <input type="checkbox" checked={allSelected} aria-label="Selecionar todas as notas visíveis"
                      onChange={(event) => setSelected(event.target.checked ? new Set(selectable.map((row) => row.invoiceId)) : new Set())} />
                  )}
                </th>
                <th scope="col">Prestador</th>
                <th scope="col">Empresa pagadora</th>
                <th scope="col">Previsto</th>
                <th scope="col">Limite NF</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                return (
                  <tr key={row.closingId}>
                    <td className={styles.invoiceSelectCell}>
                      {row.hasInvoice && row.reviewStatus !== "approved" && (
                        <input type="checkbox" checked={selected.has(row.invoiceId)}
                          aria-label={`Selecionar a nota de ${row.providerName}`}
                          onChange={(event) => setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.invoiceId); else next.delete(row.invoiceId);
                            return next;
                          })} />
                      )}
                    </td>
                    <th scope="row">
                      {row.hasInvoice ? (
                        <button type="button" className={styles.contractorDetailButton}
                          onClick={() => void openDetail(row.invoiceId)}
                          aria-label={`Abrir a nota fiscal de ${row.providerName}`}>
                          {row.providerName}
                        </button>
                      ) : row.providerName}
                      <small>{row.providerDocument || row.contractReference || "Sem CNPJ informado"}</small>
                    </th>
                    <td>{row.companyName}<small>{row.companyDocument}</small></td>
                    <td><strong>{money(row.expectedAmount)}</strong></td>
                    <td>{row.invoiceLimitAmount === null ? "—" : money(row.invoiceLimitAmount)}</td>
                    <td className={styles.rowActions}>
                      {row.hasInvoice && (
                        <button type="button" onClick={() => void openDetail(row.invoiceId)} disabled={busy}>
                          <Eye aria-hidden="true" /> Visualizar NF
                        </button>
                      )}
                      {permissions?.create && row.closingStatus !== "closed" && row.closingStatus !== "paid" && (
                        <button type="button" disabled={busy}
                          onClick={() => { setUploadError(""); setDuplicateWarning(""); setUploadRow(row); }}>
                          <FileUp aria-hidden="true" /> {row.hasInvoice ? "Substituir" : "Anexar NF"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {permissions?.export && (
        <footer className={styles.invoiceReportBar} aria-labelledby="invoice-report-title">
          <div className={styles.invoiceReportIntro}>
            <span className={styles.eyebrow}>EXPORTAÇÃO</span>
            <strong id="invoice-report-title">Relatório de notas fiscais</strong>
            <small>Exporte os dados ou reúna os documentos de {competenceLabel(competence)}.</small>
          </div>
          <div className={styles.invoiceReportActions}>
            <a className={styles.secondaryButton} href={reportUrl("contractor-invoices")}>
              <FileSpreadsheet aria-hidden="true" /> Baixar relatório (CSV)
            </a>
            {archivedDocuments > 0 ? (
              <a className={styles.primaryButton} href={archiveUrl}>
                <Download aria-hidden="true" /> Baixar todas as notas (ZIP)
              </a>
            ) : (
              <button type="button" className={styles.primaryButton} disabled
                title="Nenhuma nota fiscal possui arquivo anexado nesta competência">
                <Download aria-hidden="true" /> Baixar todas as notas (ZIP)
              </button>
            )}
          </div>
        </footer>
      )}

      {toast && <p className={styles.toast} role="status">{toast}</p>}

      <InvoiceUploadDialog
        open={Boolean(uploadRow)}
        row={uploadRow}
        competenceLabel={competenceLabel(competence)}
        money={money}
        busy={busy}
        error={uploadError}
        duplicateWarning={duplicateWarning}
        onClose={() => { setUploadRow(null); setUploadError(""); setDuplicateWarning(""); }}
        onSubmit={(form, confirmDuplicate) => void submitUpload(form, confirmDuplicate)}
      />

      <InvoiceReviewDrawer
        detail={detail}
        loading={detailLoading && !detail}
        busy={busy}
        money={money}
        error={detailError}
        onClose={() => { setDetail(null); setDetailId(""); setDetailError(""); }}
        onReview={(input) => void submitReview(input)}
        onReload={() => { if (detailId) void openDetail(detailId); }}
        onReplace={() => {
          const row = rows.find((item) => item.invoiceId === detail?.invoice.id);
          if (!row) return;
          setDetail(null);
          setUploadError("");
          setDuplicateWarning("");
          setUploadRow(row);
        }}
      />

      {/* Ação em lote exige confirmação explícita, e a de correção exige motivo:
          o motivo é o que o prestador vai ler para saber o que corrigir (§19). */}
      {batch?.action === "request_correction" ? (
        <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setBatch(null); }}>
          <form className={styles.dialog}
            onSubmit={(event) => { event.preventDefault(); void submitBatch(); }}>
            <header className={styles.dialogHeader}>
              <div>
                <span className={styles.eyebrow}>AÇÃO EM LOTE</span>
                <h2>Solicitar correção de {selectedRows.length} nota(s)</h2>
              </div>
            </header>
            <div className={styles.dialogBody}>
              <label>Motivo
                <select value={batchReason} onChange={(event) => setBatchReason(event.target.value)}>
                  {invoiceRejectionReasons.map((item) => (
                    <option key={item} value={item}>{invoiceRejectionReasonLabels[item]}</option>
                  ))}
                </select>
              </label>
              <label>Descrição{batchReason === "other" ? " (obrigatória)" : ""}
                <input value={batchDetail} maxLength={500} required={batchReason === "other"}
                  onChange={(event) => setBatchDetail(event.target.value)} />
              </label>
              <p className={styles.hint}>
                Cada nota recebe o seu próprio registro de auditoria com este motivo.
              </p>
            </div>
            <footer className={styles.dialogFooter}>
              <button type="button" className={styles.secondaryButton} onClick={() => setBatch(null)} disabled={busy}>Cancelar</button>
              <button type="submit" className={styles.primaryButton} disabled={busy}>
                {busy ? "Aplicando…" : "Confirmar"}
              </button>
            </footer>
          </form>
        </div>
      ) : (
        <ConfirmDialog
          open={batch !== null}
          title={batch?.action === "approve"
            ? `Aprovar ${selectedRows.length} nota(s) fiscal(is)?`
            : `Marcar ${selectedRows.length} nota(s) para conferência?`}
          consequence={batch?.action === "approve"
            ? `A aprovação libera o pagamento de ${selectedRows.length} prestador(es) e gera um registro de auditoria por nota. Confira os valores antes de confirmar.`
            : `As notas selecionadas passam para "aguardando conferência" e ficam atribuídas a você.`}
          confirmLabel={batch?.action === "approve" ? "Aprovar todas" : "Marcar para conferência"}
          busy={busy}
          onCancel={() => setBatch(null)}
          onConfirm={() => void submitBatch()}
        />
      )}
    </>
  );
}

function IndicatorCard({ label, value, onClick, active, alert }: {
  label: string; value: number | string; onClick: () => void; active: boolean; alert?: boolean;
}) {
  return (
    <article data-alert={alert ? "true" : "false"} data-active={active ? "true" : "false"}>
      <button type="button" className={styles.invoiceIndicatorButton} onClick={onClick}>
        <span>{label}</span>
        <strong>{value}</strong>
      </button>
    </article>
  );
}
