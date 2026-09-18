"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Check, Inbox, Loader2, RotateCcw, SkipForward } from "lucide-react";
import {
  formatBRL, formatCompetence, ledgerCategoryLabels, ledgerInstallmentStatusLabels,
} from "@/lib/payroll-ledger";
import type { LedgerCategory, LedgerInstallmentStatus } from "@/lib/payroll-ledger";
import { EmptyState, StatusPill } from "../shared/panel-ui";
import type { PanelTone } from "../shared/status-tone";
import styles from "./ledger.module.css";
import type { LedgerInstallment, LedgerPermissions } from "./ledger.types";

const tone: Record<LedgerInstallmentStatus, PanelTone> = {
  scheduled: "neutral",
  partially_discounted: "warning",
  discounted: "safe",
  skipped: "warning",
  rescheduled: "warning",
  canceled: "neutral",
};

export type InstallmentAction =
  | { kind: "confirm"; installment: LedgerInstallment }
  | { kind: "override"; installment: LedgerInstallment }
  | { kind: "reverse"; installment: LedgerInstallment }
  | { kind: "reschedule"; installment: LedgerInstallment }
  | { kind: "skip"; installment: LedgerInstallment };

/**
 * A conferência da competência, parcela a parcela.
 *
 * O que esta tela insiste em separar, e que a planilha misturava numa célula:
 *
 *  * **previsto** é o que a programação diz;
 *  * **descontado** é o que alguém confirmou, com nome e hora;
 *  * **saldo** é a diferença, e é o número que sobrevive ao fim do mês.
 *
 * O botão de confirmar já vem com o valor que **falta** preenchido, porque é o
 * caso comum. Digitar menos é desconto parcial e é aceito; digitar mais só
 * passa como ajuste autorizado, com justificativa — e essa porta tem permissão
 * própria.
 */
export function InstallmentsPanel({
  installments, permissions, busy, onAction,
}: {
  installments: LedgerInstallment[];
  permissions: LedgerPermissions | undefined;
  busy: boolean;
  onAction: (action: InstallmentAction) => void;
}) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return installments;
    return installments.filter((part) =>
      part.employeeName.toLowerCase().includes(term)
      || part.providerName.toLowerCase().includes(term)
      || part.entryTitle.toLowerCase().includes(term));
  }, [installments, search]);

  const totals = useMemo(() => visible.reduce((acc, part) => ({
    planned: acc.planned + part.plannedAmount,
    discounted: acc.discounted + part.discountedAmount,
    remaining: acc.remaining + part.remainingAmount,
  }), { planned: 0, discounted: 0, remaining: 0 }), [visible]);

  if (!installments.length) {
    return (
      <EmptyState
        icon={Inbox}
        title="Nenhuma parcela neste recorte"
        text="As parcelas aparecem depois que o lançamento é aprovado. Escolha outra competência ou remova os filtros."
      />
    );
  }

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
        <span>
          {visible.length} parcela(s) · previsto {formatBRL(totals.planned)} · descontado {formatBRL(totals.discounted)} · saldo {formatBRL(totals.remaining)}
        </span>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Pessoa</th>
              <th>Lançamento</th>
              <th>Competência</th>
              <th>Parcela</th>
              <th className={styles.amount}>Previsto</th>
              <th className={styles.amount}>Descontado</th>
              <th className={styles.amount}>Saldo</th>
              <th>Situação</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((part) => {
              const aberta = part.remainingAmount > 0
                && !["canceled", "rescheduled", "skipped"].includes(part.status);
              return (
                <tr key={part.id}>
                  <td data-label="Pessoa">
                    <strong>{part.employeeName || part.providerName || "—"}</strong>
                    <small>{[part.companyName, part.unitLabel, part.departmentLabel].filter(Boolean).join(" · ")}</small>
                  </td>
                  <td data-label="Lançamento">
                    <strong>{part.entryTitle}</strong>
                    <small>
                      {ledgerCategoryLabels[part.category as LedgerCategory] ?? part.category}
                      {part.settlementTarget === "contractor_payment" ? " · liquida no fechamento PJ" : ""}
                    </small>
                  </td>
                  <td data-label="Competência">{formatCompetence(part.competence)}</td>
                  <td data-label="Parcela">{part.number}{part.totalCount ? `/${part.totalCount}` : ""}</td>
                  <td data-label="Previsto" className={styles.amount}>{formatBRL(part.plannedAmount)}</td>
                  <td data-label="Descontado" className={styles.amount}>{formatBRL(part.discountedAmount)}</td>
                  <td data-label="Saldo" className={styles.amount}>{formatBRL(part.remainingAmount)}</td>
                  <td data-label="Situação">
                    <StatusPill
                      status={part.status}
                      label={ledgerInstallmentStatusLabels[part.status]}
                      tone={tone[part.status]}
                    />
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      {permissions?.confirm && aberta && (
                        <button
                          type="button"
                          className={styles.rowAction}
                          disabled={busy}
                          onClick={() => onAction({ kind: "confirm", installment: part })}
                        >
                          {busy ? <Loader2 aria-hidden="true" className={styles.spin} /> : <Check aria-hidden="true" />}
                          Confirmar
                        </button>
                      )}
                      {permissions?.reverse && part.discountedAmount > 0 && (
                        <button
                          type="button"
                          className={styles.rowAction}
                          disabled={busy}
                          onClick={() => onAction({ kind: "reverse", installment: part })}
                        >
                          <RotateCcw aria-hidden="true" /> Estornar
                        </button>
                      )}
                      {permissions?.override && aberta && (
                        <button
                          type="button"
                          className={styles.rowAction}
                          disabled={busy}
                          onClick={() => onAction({ kind: "override", installment: part })}
                        >
                          Ajuste autorizado
                        </button>
                      )}
                      {permissions?.reschedule && part.discountedAmount === 0 && part.status === "scheduled" && (
                        <>
                          <button
                            type="button"
                            className={styles.rowAction}
                            disabled={busy}
                            onClick={() => onAction({ kind: "reschedule", installment: part })}
                          >
                            <CalendarClock aria-hidden="true" /> Reprogramar
                          </button>
                          <button
                            type="button"
                            className={styles.rowAction}
                            disabled={busy}
                            onClick={() => onAction({ kind: "skip", installment: part })}
                          >
                            <SkipForward aria-hidden="true" /> Pular
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
