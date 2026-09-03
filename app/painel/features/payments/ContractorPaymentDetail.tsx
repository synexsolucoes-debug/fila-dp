"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDownRight, ArrowUpRight, Download, Pencil, Trash2, X } from "lucide-react";
import type { ContractorComponent, ContractorPaymentDetail as Detail } from "./payments.types";
import { ContractorAnalyticalStatement } from "./ContractorAnalyticalStatement";
import styles from "./payments.module.css";
import { contractorComponentLabel } from "@/lib/payments";


const originLabels: Record<string, string> = {
  manual: "Pontual",
  fixed_item: "Fixo recorrente",
  import: "Importado",
  integration: "Integração",
};

const money = (value: number) => new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
}).format(value || 0);

const date = (value: string) => value
  ? new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`))
  : "";

type Props = {
  detail: Detail;
  busy: boolean;
  onClose: () => void;
  onUpdateComponent: (componentId: string, input: { amount: string; description: string }) => Promise<boolean>;
  onCancelComponent: (componentId: string, reason: string) => Promise<boolean>;
  onDeleteClosing: (reason: string) => Promise<boolean>;
  onDownloadReceipt: () => Promise<void>;
};

export function ContractorPaymentDetail({
  detail,
  busy,
  onClose,
  onUpdateComponent,
  onCancelComponent,
  onDeleteClosing,
  onDownloadReceipt,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [editingId, setEditingId] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [cancelingId, setCancelingId] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");

  const credits = useMemo(() => detail.components.filter((item) => item.direction === "credit"), [detail.components]);
  const debits = useMemo(() => detail.components.filter((item) => item.direction === "debit"), [detail.components]);
  const earnings = detail.closing.baseAmount + detail.closing.creditsAmount;
  const prorated = detail.closing.prorationDays !== null && detail.closing.prorationTotalDays !== null;
  const locked = detail.closing.status === "closed" || detail.closing.status === "paid";
  const canEdit = detail.permissions.manage && !locked;
  const canDelete = detail.permissions.manage && (!locked || detail.permissions.reopen);

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const selector = "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    panel?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter((item) => item.getClientRects().length > 0);
      if (items.length === 0) { event.preventDefault(); panel.focus(); return; }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, []);

  function beginEdit(item: ContractorComponent) {
    setCancelingId("");
    setEditingId(item.id);
    setEditDescription(item.description || contractorComponentLabel(item.componentType));
    setEditAmount(String(item.amount).replace(".", ","));
  }

  async function saveEdit(event: FormEvent, item: ContractorComponent) {
    event.preventDefault();
    if (!editAmount.trim()) return;
    const ok = await onUpdateComponent(item.id, { amount: editAmount, description: editDescription });
    if (ok) setEditingId("");
  }

  async function confirmCancel(event: FormEvent, item: ContractorComponent) {
    event.preventDefault();
    if (cancelReason.trim().length < 5) return;
    const ok = await onCancelComponent(item.id, cancelReason.trim());
    if (ok) {
      setCancelingId("");
      setCancelReason("");
    }
  }

  function rows(items: ContractorComponent[]) {
    if (items.length === 0) {
      return <tr><td colSpan={5} className={styles.detailEmpty}>Nenhum lançamento nesta competência.</td></tr>;
    }
    return items.map((item) => {
      const fixed = item.origin === "fixed_item";
      const editable = canEdit && item.status === "active" && !fixed;
      return (
        <Fragment key={item.id}>
          <tr data-canceled={item.status === "canceled" ? "true" : "false"}>
            <td>
              {editingId === item.id ? (
                <input
                  className={styles.inlineInput}
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.target.value)}
                  aria-label="Descrição do lançamento"
                  disabled={busy}
                />
              ) : (
                item.description || contractorComponentLabel(item.componentType)
              )}
            </td>
            <td>{originLabels[item.origin] || item.origin}</td>
            <td>{item.status === "canceled" ? "Cancelado" : "Ativo"}</td>
            <td>
              {editingId === item.id ? (
                <input
                  className={styles.inlineMoney}
                  value={editAmount}
                  onChange={(event) => setEditAmount(event.target.value)}
                  inputMode="decimal"
                  aria-label="Valor do lançamento"
                  disabled={busy}
                />
              ) : money(item.amount)}
            </td>
            <td className={styles.detailActions}>
              {editingId === item.id ? (
                <form onSubmit={(event) => void saveEdit(event, item)}>
                  <button type="submit" disabled={busy || !editAmount.trim()}>Salvar</button>
                  <button type="button" disabled={busy} onClick={() => setEditingId("")}>Cancelar</button>
                </form>
              ) : editable ? (
                <>
                  <button type="button" onClick={() => beginEdit(item)} disabled={busy}>
                    <Pencil aria-hidden="true" /> Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingId(""); setCancelingId(item.id); setCancelReason(""); }}
                    disabled={busy}
                  >
                    Cancelar lançamento
                  </button>
                </>
              ) : fixed && item.status === "active" ? (
                <span className={styles.detailActionHint}>Edite no lançamento fixo</span>
              ) : (
                <span className={styles.detailActionHint}>—</span>
              )}
            </td>
          </tr>
          {cancelingId === item.id ? (
            <tr className={styles.inlineActionRow}>
              <td colSpan={5}>
                <form onSubmit={(event) => void confirmCancel(event, item)}>
                  <label>
                    Motivo do cancelamento
                    <input
                      value={cancelReason}
                      onChange={(event) => setCancelReason(event.target.value)}
                      placeholder="Ex.: lançamento duplicado"
                      minLength={5}
                      disabled={busy}
                      autoFocus
                    />
                  </label>
                  <button type="submit" disabled={busy || cancelReason.trim().length < 5}>Confirmar cancelamento</button>
                  <button type="button" onClick={() => setCancelingId("")} disabled={busy}>Voltar</button>
                </form>
              </td>
            </tr>
          ) : null}
        </Fragment>
      );
    });
  }

  async function confirmDelete(event: FormEvent) {
    event.preventDefault();
    if (deleteReason.trim().length < 5) return;
    const ok = await onDeleteClosing(deleteReason.trim());
    if (ok) setDeleteMode(false);
  }

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        className={`${styles.dialog} ${styles.detailDialog}`}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contractor-payment-detail-title"
        tabIndex={-1}
      >
        <header className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>EXTRATO ANALÍTICO DE PAGAMENTO PJ</span>
            <h2 id="contractor-payment-detail-title">{detail.provider.legalName}</h2>
            <p className={styles.detailMeta}>
              {detail.provider.roleTitle || detail.provider.contractReference || detail.provider.code} · competência {detail.closing.competence}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar detalhamento"><X aria-hidden="true" /></button>
        </header>

        <div className={styles.detailBody}>
          {locked && detail.permissions.manage ? (
            <p className={styles.detailLockedNote}>
              Este pagamento está {detail.closing.status === "closed" ? "fechado" : "pago"}. Reabra o fechamento para editar lançamentos.
            </p>
          ) : null}

          <section className={styles.paymentBreakdown} data-tone="credit" aria-labelledby="earnings-title">
            <header>
              <div><ArrowUpRight aria-hidden="true" /><h3 id="earnings-title">Proventos</h3></div>
              <strong>{money(earnings)}</strong>
            </header>
            <div className={styles.tableScroll}>
              <table className={styles.detailTable}>
                <thead><tr><th scope="col">Rubrica</th><th scope="col">Origem</th><th scope="col">Situação</th><th scope="col">Valor</th><th scope="col">Ações</th></tr></thead>
                <tbody>
                  <tr>
                    <td>
                      {prorated ? "Valor contratual proporcional" : "Valor contratual"}
                      {prorated ? (
                        <small className={styles.detailRowMeta}>
                          {detail.closing.prorationDays} de {detail.closing.prorationTotalDays} dias proporcionais{detail.closing.prorationEndDate ? ` · encerramento em ${date(detail.closing.prorationEndDate)}` : ""}
                        </small>
                      ) : null}
                    </td>
                    <td>{prorated ? "Encerramento" : "Contratual"}</td><td>Ativo</td><td>{money(detail.closing.baseAmount)}</td>
                    <td className={styles.detailActions}>
                      <span className={styles.detailActionHint}>
                        {prorated ? `Base mensal: ${money(detail.closing.contractBaseAmount)}` : "Altere no cadastro do PJ"}
                      </span>
                    </td>
                  </tr>
                  {rows(credits)}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.paymentBreakdown} data-tone="debit" aria-labelledby="discounts-title">
            <header>
              <div><ArrowDownRight aria-hidden="true" /><h3 id="discounts-title">Descontos</h3></div>
              <strong>{money(detail.closing.debitsAmount)}</strong>
            </header>
            <div className={styles.tableScroll}>
              <table className={styles.detailTable}>
                <thead><tr><th scope="col">Rubrica</th><th scope="col">Origem</th><th scope="col">Situação</th><th scope="col">Valor</th><th scope="col">Ações</th></tr></thead>
                <tbody>{rows(debits)}</tbody>
              </table>
            </div>
          </section>

          <ContractorAnalyticalStatement detail={detail} />

          {deleteMode ? (
            <section className={styles.deletePaymentPanel} aria-label="Excluir pagamento da competência">
              <div>
                <Trash2 aria-hidden="true" />
                <div>
                  <strong>Excluir pagamento desta competência</strong>
                  <p>Ele sairá da tela, totais, relatórios e Caju. O registro original continuará preservado para auditoria.</p>
                </div>
              </div>
              <form onSubmit={(event) => void confirmDelete(event)}>
                <label>
                  Motivo da exclusão
                  <input
                    value={deleteReason}
                    onChange={(event) => setDeleteReason(event.target.value)}
                    minLength={5}
                    placeholder="Ex.: prestador encerrado antes desta competência"
                    disabled={busy}
                    autoFocus
                  />
                </label>
                <button className={styles.dangerButton} type="submit" disabled={busy || deleteReason.trim().length < 5}>Confirmar exclusão</button>
                <button className={styles.secondaryButton} type="button" onClick={() => setDeleteMode(false)} disabled={busy}>Cancelar</button>
              </form>
            </section>
          ) : null}
        </div>

        <footer className={styles.dialogFooter}>
          {detail.permissions.manage ? (
            <button
              className={styles.dangerButton}
              type="button"
              onClick={() => setDeleteMode(true)}
              disabled={busy || !canDelete}
              title={!canDelete && locked ? "Você precisa da permissão de reabertura para excluir um pagamento fechado." : undefined}
            >
              <Trash2 aria-hidden="true" /> Excluir pagamento
            </button>
          ) : <span />}
          <button className={styles.secondaryButton} type="button" onClick={() => void onDownloadReceipt()} disabled={busy}>
            <Download aria-hidden="true" /> Gerar recibo de pagamento
          </button>
          <button className={styles.primaryButton} type="button" onClick={onClose} disabled={busy}>Fechar</button>
        </footer>
      </div>
    </div>
  );
}
