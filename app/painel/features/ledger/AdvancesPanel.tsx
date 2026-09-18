"use client";

import { useMemo, useState } from "react";
import { Ban, CalendarPlus, Check, Inbox, Info, Loader2, TriangleAlert, Wallet } from "lucide-react";
import { formatBRL, formatCompetence } from "@/lib/payroll-ledger";
import { EmptyState, StatusPill } from "../shared/panel-ui";
import type { PanelTone } from "../shared/status-tone";
import styles from "./ledger.module.css";
import type { LedgerAdvancePayment } from "./ledger.api";
import type { LedgerPermissions } from "./ledger.types";

const statusLabels: Record<LedgerAdvancePayment["status"], string> = {
  scheduled: "Programado",
  pending_data: "Pendência",
  authorized: "Autorizado",
  paid: "Pago",
  canceled: "Suspenso",
};

const tone: Record<LedgerAdvancePayment["status"], PanelTone> = {
  scheduled: "neutral",
  pending_data: "warning",
  authorized: "info",
  paid: "safe",
  canceled: "neutral",
};

export type AdvanceAction =
  | { kind: "authorize"; payment: LedgerAdvancePayment }
  | { kind: "pay"; payment: LedgerAdvancePayment }
  | { kind: "cancel"; payment: LedgerAdvancePayment }
  | { kind: "resolve_pending"; payment: LedgerAdvancePayment };

/**
 * Adiantamentos da competência.
 *
 * As duas colunas que justificam a tela inteira ficam lado a lado: **pago ao
 * colaborador** e **recuperado dele**. São o mesmo lançamento visto dos dois
 * lados, e confundi-las é o defeito que fez este módulo existir — na planilha,
 * "vale de 500" podia significar que o dinheiro saiu, que ia sair, ou que já
 * tinha sido descontado, e a célula não dizia qual.
 *
 * Gerar a programação não paga nada. Pagar não desconta nada. Cada passo tem
 * botão próprio, e o de pagar tem permissão própria.
 */
export function AdvancesPanel({
  payments, permissions, busy, competence, onAction, onSchedule,
}: {
  payments: LedgerAdvancePayment[];
  permissions: LedgerPermissions | undefined;
  busy: boolean;
  competence: string;
  onAction: (action: AdvanceAction) => void;
  onSchedule: () => void;
}) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return payments;
    return payments.filter((payment) =>
      payment.employeeName.toLowerCase().includes(term)
      || payment.entryTitle.toLowerCase().includes(term));
  }, [payments, search]);

  const totals = useMemo(() => visible.reduce((acc, payment) => ({
    previsto: acc.previsto + (payment.status === "canceled" ? 0 : payment.approvedAmount),
    pago: acc.pago + payment.paidAmount,
    recuperado: acc.recuperado + payment.recoveredAmount,
    pendentes: acc.pendentes + (payment.status === "pending_data" ? 1 : 0),
  }), { previsto: 0, pago: 0, recuperado: 0, pendentes: 0 }), [visible]);

  return (
    <>
      <div className={styles.tableTools}>
        <label className={styles.checkboxFilter}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar pessoa ou lançamento"
            aria-label="Buscar pessoa ou lançamento"
          />
        </label>
        {permissions?.manage && (
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onSchedule}>
            {busy ? <Loader2 aria-hidden="true" className={styles.spin} /> : <CalendarPlus aria-hidden="true" />}
            Gerar programação de {formatCompetence(competence)}
          </button>
        )}
      </div>

      {totals.pendentes > 0 && (
        <p className={styles.notice} data-tone="warning">
          <TriangleAlert aria-hidden="true" />
          <span>
            {totals.pendentes} adiantamento(s) sem valor calculado. São regras percentuais sem base salarial
            informada — o produto prefere apontar a pendência a pagar R$ 0,00 sem ninguém perceber.
          </span>
        </p>
      )}

      {visible.length ? (
        <>
          <div className={styles.metrics}>
            <article>
              <Wallet aria-hidden="true" />
              <span>Previsto na competência</span>
              <strong>{formatBRL(totals.previsto)}</strong>
              <small>{visible.length} adiantamento(s)</small>
            </article>
            <article>
              <span>Pago ao colaborador</span>
              <strong>{formatBRL(totals.pago)}</strong>
              <small>Dinheiro que saiu</small>
            </article>
            <article>
              <span>Recuperado</span>
              <strong>{formatBRL(totals.recuperado)}</strong>
              <small>Descontos já confirmados</small>
            </article>
            <article>
              <span>A recuperar</span>
              <strong>{formatBRL(Math.max(0, totals.pago - totals.recuperado))}</strong>
              <small>Pago e ainda não descontado</small>
            </article>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>Pessoa</th>
                  <th>Empresa / unidade</th>
                  <th>Competência</th>
                  <th className={styles.amount}>Aprovado</th>
                  <th className={styles.amount}>Pago</th>
                  <th className={styles.amount}>Recuperado</th>
                  <th>Situação</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((payment) => (
                  <tr key={payment.id}>
                    <td data-label="Pessoa">
                      <strong>{payment.employeeName || "—"}</strong>
                      <small>
                        {payment.registrationNumber ? `Matrícula ${payment.registrationNumber} · ` : ""}
                        {payment.entryTitle}
                      </small>
                    </td>
                    <td data-label="Empresa / unidade">
                      <strong>{payment.companyName}</strong>
                      <small>{[payment.unitLabel, payment.departmentLabel].filter(Boolean).join(" · ") || "—"}</small>
                    </td>
                    <td data-label="Competência">
                      {formatCompetence(payment.competence)}
                      {payment.expectedPaymentDate && <small>previsto {payment.expectedPaymentDate}</small>}
                    </td>
                    <td data-label="Aprovado" className={styles.amount}>
                      {payment.status === "pending_data" ? "—" : formatBRL(payment.approvedAmount)}
                    </td>
                    <td data-label="Pago" className={styles.amount}>
                      {payment.paidAmount > 0 ? formatBRL(payment.paidAmount) : "—"}
                      {payment.actualPaymentDate && <small>{payment.actualPaymentDate}</small>}
                    </td>
                    <td data-label="Recuperado" className={styles.amount}>
                      {payment.recoveryPlannedAmount > 0
                        ? <>{formatBRL(payment.recoveredAmount)}<small>de {formatBRL(payment.recoveryPlannedAmount)}</small></>
                        : "—"}
                    </td>
                    <td data-label="Situação">
                      <StatusPill status={payment.status} label={statusLabels[payment.status]} tone={tone[payment.status]} />
                      {payment.status === "pending_data" && <small>{payment.pendingReason}</small>}
                      {payment.status === "canceled" && <small>{payment.cancelReason}</small>}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        {permissions?.manage && payment.status === "pending_data" && (
                          <button type="button" className={styles.rowAction} disabled={busy}
                            onClick={() => onAction({ kind: "resolve_pending", payment })}>
                            <Info aria-hidden="true" /> Informar valor
                          </button>
                        )}
                        {permissions?.manage && payment.status === "scheduled" && (
                          <button type="button" className={styles.rowAction} disabled={busy}
                            onClick={() => onAction({ kind: "authorize", payment })}>
                            <Check aria-hidden="true" /> Autorizar
                          </button>
                        )}
                        {permissions?.pay && payment.status === "authorized" && (
                          <button type="button" className={styles.rowAction} disabled={busy}
                            onClick={() => onAction({ kind: "pay", payment })}>
                            <Wallet aria-hidden="true" /> Registrar pagamento
                          </button>
                        )}
                        {permissions?.manage && payment.status !== "paid" && payment.status !== "canceled" && (
                          <button type="button" className={styles.rowAction} disabled={busy}
                            onClick={() => onAction({ kind: "cancel", payment })}>
                            <Ban aria-hidden="true" /> Suspender
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <EmptyState
          icon={Inbox}
          title={`Nenhum adiantamento em ${formatCompetence(competence)}`}
          text="Gere a programação da competência para trazer os adiantamentos recorrentes cuja vigência cobre este mês. Gerar não paga nada."
          action={permissions?.manage ? (
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onSchedule}>
              <CalendarPlus aria-hidden="true" /> Gerar programação
            </button>
          ) : undefined}
        />
      )}
    </>
  );
}
