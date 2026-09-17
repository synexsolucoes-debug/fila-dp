"use client";

import { useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { formatBRL, formatCompetence } from "@/lib/payroll-ledger";
import styles from "./ledger.module.css";
import type { AdvanceAction } from "./AdvancesPanel";

type Payload = {
  paidAmount: string;
  approvedAmount: string;
  actualPaymentDate: string;
  recoveryCompetence: string;
  cancelReason: string;
};

/**
 * As quatro ações sobre um adiantamento da competência.
 *
 * A de pagar é a que carrega a frase mais importante do módulo: registrar o
 * pagamento **cria a obrigação de recuperar** aquele valor, e cria uma só. Ela
 * nasce programada, não descontada — o dinheiro saiu para a pessoa, voltar é
 * outro fato, com porta própria.
 */
export function AdvanceActionDialog({
  action, busy, error, onCancel, onSubmit,
}: {
  action: AdvanceAction;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (payload: Payload) => void;
}) {
  const { payment } = action;
  const [payload, setPayload] = useState<Payload>({
    paidAmount: payment.approvedAmount > 0 ? payment.approvedAmount.toFixed(2).replace(".", ",") : "",
    approvedAmount: "",
    actualPaymentDate: new Date().toISOString().slice(0, 10),
    recoveryCompetence: payment.competence,
    cancelReason: "",
  });
  const set = <K extends keyof Payload>(key: K, value: Payload[K]) => setPayload({ ...payload, [key]: value });

  const titulos: Record<AdvanceAction["kind"], string> = {
    authorize: "Autorizar o adiantamento",
    pay: "Registrar o pagamento",
    cancel: "Suspender nesta competência",
    resolve_pending: "Informar o valor do adiantamento",
  };

  const faltando =
    (action.kind === "pay" && (!payload.paidAmount.trim() || !payload.actualPaymentDate.trim() || !payload.recoveryCompetence.trim()))
    || (action.kind === "cancel" && payload.cancelReason.trim().length < 5)
    || (action.kind === "resolve_pending" && !payload.approvedAmount.trim());

  return (
    <div className={styles.drawerBackdrop} role="dialog" aria-modal="true" aria-label={titulos[action.kind]}>
      <form className={styles.drawer} onSubmit={(event) => { event.preventDefault(); if (!faltando) onSubmit(payload); }}>
        <div className={styles.drawerHead}>
          <div>
            <h2>{titulos[action.kind]}</h2>
            <p>{payment.employeeName} · {payment.entryTitle} · {formatCompetence(payment.competence)}</p>
          </div>
        </div>

        {error && <p className={styles.notice} data-tone="warning"><Info aria-hidden="true" />{error}</p>}

        {action.kind === "authorize" && (
          <>
            <dl className={styles.definitionList}>
              <div><dt>Valor aprovado</dt><dd>{formatBRL(payment.approvedAmount)}</dd></div>
              <div><dt>Data prevista</dt><dd>{payment.expectedPaymentDate || "—"}</dd></div>
            </dl>
            <p className={styles.notice}>
              <Info aria-hidden="true" />
              <span>Autorizar libera o pagamento para registro. <strong>Não paga</strong> e não desconta nada.</span>
            </p>
          </>
        )}

        {action.kind === "resolve_pending" && (
          <>
            <p className={styles.notice} data-tone="warning">
              <Info aria-hidden="true" />
              <span>{payment.pendingReason}</span>
            </p>
            <div className={styles.formGrid}>
              <label>
                Valor do adiantamento
                <input value={payload.approvedAmount} onChange={(event) => set("approvedAmount", event.target.value)} inputMode="decimal" autoFocus />
              </label>
            </div>
          </>
        )}

        {action.kind === "pay" && (
          <>
            <dl className={styles.definitionList}>
              <div><dt>Valor aprovado</dt><dd>{formatBRL(payment.approvedAmount)}</dd></div>
              <div><dt>Data prevista</dt><dd>{payment.expectedPaymentDate || "—"}</dd></div>
            </dl>
            <p className={styles.notice}>
              <Info aria-hidden="true" />
              <span>
                Registrar o pagamento cria <strong>uma</strong> parcela de recuperação na competência escolhida —
                programada, não descontada. O dinheiro saiu para a pessoa; voltar é outro fato, e quem confirma é a
                conferência da competência.
              </span>
            </p>
            <div className={styles.formGrid}>
              <label>
                Valor efetivamente pago
                <input value={payload.paidAmount} onChange={(event) => set("paidAmount", event.target.value)} inputMode="decimal" autoFocus />
                <span className={styles.fieldHint}>Pode diferir do aprovado. O que vale para a recuperação é o que saiu.</span>
              </label>
              <label>
                Data efetiva do pagamento
                <input type="date" value={payload.actualPaymentDate} onChange={(event) => set("actualPaymentDate", event.target.value)} />
              </label>
              <label className={styles.fullWidth}>
                Competência da recuperação
                <input value={payload.recoveryCompetence} onChange={(event) => set("recoveryCompetence", event.target.value)} placeholder="2026-09" />
                <span className={styles.fieldHint}>
                  Em qual folha este valor volta. O padrão é a própria competência do adiantamento.
                </span>
              </label>
            </div>
          </>
        )}

        {action.kind === "cancel" && (
          <>
            <p className={styles.notice}>
              <Info aria-hidden="true" />
              <span>
                Suspender tira o adiantamento <strong>desta competência</strong>. A regra continua valendo para os
                meses seguintes — e o motivo fica registrado, porque &quot;por que o vale de julho não saiu?&quot; é
                uma pergunta que alguém vai fazer depois.
              </span>
            </p>
            <div className={styles.formGrid}>
              <label className={styles.fullWidth}>
                Motivo
                <textarea value={payload.cancelReason} onChange={(event) => set("cancelReason", event.target.value)} maxLength={500} autoFocus />
              </label>
            </div>
          </>
        )}

        <div className={styles.formActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="submit" className={styles.primaryButton} disabled={busy || faltando}>
            {busy && <Loader2 aria-hidden="true" className={styles.spin} />}
            {titulos[action.kind]}
          </button>
        </div>
      </form>
    </div>
  );
}
