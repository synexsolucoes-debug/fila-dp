"use client";

import { useRef, useState } from "react";
import {
  ArrowRight, CalendarCheck, Download, Info, Loader2, TriangleAlert, Upload,
} from "lucide-react";
import { formatBRL, formatCompetence, ledgerBatchStatusLabels } from "@/lib/payroll-ledger";
import type { LedgerBatchStatus } from "@/lib/payroll-ledger";
import { EmptyState, StatusPill } from "../shared/panel-ui";
import type { PanelTone } from "../shared/status-tone";
import styles from "./ledger.module.css";
import type { LedgerBatch, LedgerCompetenceSummary, LedgerReturnResult } from "./ledger.api";
import type { LedgerPermissions } from "./ledger.types";

const tone: Record<LedgerBatchStatus, PanelTone> = {
  draft: "neutral",
  in_review: "info",
  approved: "info",
  exported: "info",
  sent_to_payroll: "warning",
  confirmed: "safe",
  closed: "safe",
  reopened: "warning",
};

/**
 * O caminho da conferência, nesta ordem e sem atalho.
 *
 * Os três estados do meio são o que a planilha escrevia igual: "lançado na
 * Domínio" podia significar que o arquivo saiu, que alguém digitou na folha ou
 * que o desconto aconteceu. Separá-los é o que permite responder, em setembro,
 * por que o desconto de julho não apareceu no contracheque.
 */
const passos: { status: LedgerBatchStatus; rotulo: string; explica: string }[] = [
  { status: "in_review", rotulo: "Conferir", explica: "A programação do mês entra em conferência." },
  { status: "approved", rotulo: "Aprovar", explica: "Autoriza o que vai para a folha. Bloqueado enquanto houver lançamento sem aprovação." },
  { status: "exported", rotulo: "Exportado", explica: "O arquivo saiu daqui. Nada foi descontado ainda." },
  { status: "sent_to_payroll", rotulo: "Lançado na folha", explica: "Alguém digitou no sistema de folha. Continua sem desconto confirmado." },
  { status: "confirmed", rotulo: "Desconto confirmado", explica: "Os valores efetivamente descontados voltaram e foram registrados." },
  { status: "closed", rotulo: "Encerrar", explica: "Grava a versão rastreável da conferência." },
];

export function CompetencePanel({
  batch, summary, competence, companyId, permissions, busy, returnResult,
  onOpen, onMove, onExport, onImportReturn,
}: {
  batch: LedgerBatch | null;
  summary: LedgerCompetenceSummary | null;
  competence: string;
  companyId: string;
  permissions: LedgerPermissions | undefined;
  busy: boolean;
  returnResult: LedgerReturnResult | null;
  onOpen: () => void;
  onMove: (status: string, reason?: string) => void;
  onExport: () => void;
  onImportReturn: (file: File) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [reopenReason, setReopenReason] = useState("");

  if (!companyId) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title="Escolha a empresa"
        text="A conferência acontece por empresa e competência, dentro do ciclo que a Operação DP já governa."
      />
    );
  }

  if (!batch) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title={`Conferência de ${formatCompetence(competence)} ainda não aberta`}
        text="Abrir a conferência traz a programação do mês para revisão. Ela acontece dentro da competência da Operação DP — o módulo não abre competência própria."
        action={permissions?.manage ? (
          <button type="button" className={styles.primaryButton} disabled={busy} onClick={onOpen}>
            {busy ? <Loader2 aria-hidden="true" className={styles.spin} /> : <CalendarCheck aria-hidden="true" />}
            Abrir conferência
          </button>
        ) : undefined}
      />
    );
  }

  const status = batch.status as LedgerBatchStatus;
  const indiceAtual = passos.findIndex((passo) => passo.status === status);
  const proximo = passos[indiceAtual + 1] ?? (status === "draft" ? passos[0] : null);
  const bloqueado = Boolean(summary && (summary.entriesWithoutApproval > 0 || summary.advancePendingCount > 0));

  return (
    <>
      <div className={styles.tableTools}>
        <span>
          Conferência de {formatCompetence(competence)} ·{" "}
          <StatusPill status={status} label={ledgerBatchStatusLabels[status] ?? status} tone={tone[status] ?? "neutral"} />
        </span>
        {batch.approved_by_name && <span>Aprovada por {batch.approved_by_name}</span>}
        {batch.closed_by_name && <span>Encerrada por {batch.closed_by_name}</span>}
      </div>

      {summary && (
        <>
          <div className={styles.metrics}>
            <article>
              <span>Descontos programados</span>
              <strong>{formatBRL(summary.scheduledAmount)}</strong>
              <small>{summary.scheduledCount} parcela(s)</small>
            </article>
            <article>
              <span>Descontos confirmados</span>
              <strong>{formatBRL(summary.confirmedAmount)}</strong>
              <small>{summary.openCount} ainda em aberto</small>
            </article>
            <article>
              <span>Diferença</span>
              <strong>{formatBRL(summary.differenceAmount)}</strong>
              <small>Programado e ainda não confirmado</small>
            </article>
            <article>
              <span>Adiantamentos</span>
              <strong>{formatBRL(summary.advancePaidAmount)}</strong>
              <small>de {formatBRL(summary.advanceExpectedAmount)} previstos</small>
            </article>
          </div>

          <div className={styles.metrics}>
            <article>
              <span>Parcelas de competências anteriores</span>
              <strong>{formatBRL(summary.overdueAmount)}</strong>
              <small>{summary.overdueCount} parcela(s) sem confirmação — elas não somem</small>
            </article>
            <article>
              <span>Saldos futuros</span>
              <strong>{formatBRL(summary.futureAmount)}</strong>
              <small>{summary.futureCount} parcela(s) programadas adiante</small>
            </article>
            <article>
              <span>Lançamentos sem aprovação</span>
              <strong>{summary.entriesWithoutApproval}</strong>
              <small>Impedem aprovar a conferência</small>
            </article>
            <article>
              <span>Adiantamentos com pendência</span>
              <strong>{summary.advancePendingCount}</strong>
              <small>Sem valor calculado</small>
            </article>
          </div>
        </>
      )}

      {bloqueado && (
        <p className={styles.notice} data-tone="warning">
          <TriangleAlert aria-hidden="true" />
          <span>
            A conferência não pode ser aprovada enquanto houver lançamento sem aprovação ou adiantamento sem valor
            calculado. Aprovar em lote o que ninguém decidiu seria autorizar desconto por omissão.
          </span>
        </p>
      )}

      {proximo && permissions?.manage && status !== "closed" && (
        <div className={styles.notice}>
          <Info aria-hidden="true" />
          <span>
            <strong>{proximo.rotulo}</strong> — {proximo.explica}
          </span>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy || (proximo.status === "approved" && bloqueado)}
            onClick={() => onMove(proximo.status)}
          >
            {busy ? <Loader2 aria-hidden="true" className={styles.spin} /> : <ArrowRight aria-hidden="true" />}
            {proximo.rotulo}
          </button>
        </div>
      )}

      {permissions?.export && ["approved", "exported", "sent_to_payroll", "confirmed", "closed"].includes(status) && (
        <div className={styles.notice}>
          <Download aria-hidden="true" />
          <span>
            A planilha leva o identificador de cada parcela, para o retorno casar linha a linha em vez de casar por
            nome. <strong>Exportar não confirma desconto.</strong>
          </span>
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onExport}>
            <Download aria-hidden="true" /> Exportar planilha
          </button>
        </div>
      )}

      {permissions?.confirm && ["exported", "sent_to_payroll", "confirmed", "reopened"].includes(status) && (
        <div className={styles.notice}>
          <Upload aria-hidden="true" />
          <span>
            Devolva o mesmo arquivo com a coluna <strong>Desconto realizado</strong> preenchida. Linha em branco é
            linha que ninguém descontou — e não um desconto de zero.
          </span>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImportReturn(file);
              event.target.value = "";
            }}
          />
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => fileInput.current?.click()}>
            <Upload aria-hidden="true" /> Importar retorno
          </button>
        </div>
      )}

      {returnResult && (
        <div className={styles.preview}>
          <strong>
            {returnResult.confirmed} confirmação(ões) registrada(s)
            {returnResult.blank ? ` · ${returnResult.blank} linha(s) em branco` : ""}
            {returnResult.problems.length ? ` · ${returnResult.problems.length} linha(s) com problema` : ""}
          </strong>
          {returnResult.message && <small>{returnResult.message}</small>}
          {returnResult.problems.length > 0 && (
            <ol>
              {returnResult.problems.slice(0, 20).map((problema) => (
                <li key={problema.sheetRow}>Linha {problema.sheetRow}: {problema.reason}</li>
              ))}
            </ol>
          )}
          {returnResult.problems.length > 20 && <small>e mais {returnResult.problems.length - 20} linha(s).</small>}
        </div>
      )}

      {status === "closed" && permissions?.reopen && (
        <div className={styles.formGrid}>
          <label className={styles.fullWidth}>
            Motivo da reabertura
            <textarea value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} maxLength={500} />
            <span className={styles.fieldHint}>
              A versão rastreável gravada no encerramento é preservada. Reabrir não a reescreve.
            </span>
          </label>
          <div className={`${styles.fullWidth} ${styles.formActions}`}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={busy || reopenReason.trim().length < 5}
              onClick={() => onMove("reopened", reopenReason)}
            >
              Reabrir conferência
            </button>
          </div>
        </div>
      )}

      {status === "reopened" && batch.reopen_reason && (
        <p className={styles.notice} data-tone="warning">
          <TriangleAlert aria-hidden="true" />
          <span>Reaberta: {batch.reopen_reason}</span>
        </p>
      )}
    </>
  );
}
