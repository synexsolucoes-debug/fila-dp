"use client";

import {
  CircleAlert, CircleCheckBig, Clock3, Download, FileText, ReceiptText, ShieldCheck, WalletCards,
} from "lucide-react";
import { invoiceReviewStatusLabels } from "@/lib/contractor-invoices";
import type { ContractorPaymentDetail as Detail } from "./payments.types";
import styles from "./payments.module.css";

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value || 0);

const decimal = (value: number) =>
  Number(value || 0).toFixed(2).replace(".", ",");

/** Onde o desconto foi abatido, como o extrato precisa dizer por extenso. */
const settlementLabels: Record<string, string> = {
  auto: "Automática",
  invoice: "Dentro da nota fiscal",
  complement: "No complemento",
};

function formatCnpj(value: string) {
  const digits = value.replace(/\D/g, "");

  if (digits.length !== 14) {
    return value || "Não informado";
  }

  return digits.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
}

function csvCell(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function ContractorAnalyticalStatement({
  detail,
}: {
  detail: Detail;
}) {
  const credits = detail.components.filter(
    (item) => item.direction === "credit" && item.status === "active",
  );

  const debits = detail.components.filter(
    (item) => item.direction === "debit" && item.status === "active",
  );

  const totalEarnings =
    detail.closing.baseAmount + detail.closing.creditsAmount;

  /* Quanto do desconto foi abatido de cada lado do pagamento.
     Sem isto, o resumo mostra "- R$ 59,93" e não diz de onde saiu — que é
     exatamente a dúvida de quem confere uma nota menor do que o limite. */
  const debitsOn = (target: string) => debits
    .filter((item) => (item.settlementTarget || "auto") === target)
    .reduce((total, item) => total + item.amount, 0);
  const debitsOnInvoice = debitsOn("invoice");
  const debitsOnComplement = debitsOn("complement");
  const splitPayment = detail.closing.complementAmount > 0 || detail.closing.invoiceExpectedAmount < detail.closing.netAmount;

  const reviewStatus = detail.closing.invoiceReviewStatus;
  const invoiceNotRequired = reviewStatus === "not_required";
  const invoiceReceived = Boolean(detail.closing.invoiceNumber) || ![
    "", "not_required", "awaiting_issue",
  ].includes(reviewStatus);

  const invoiceDifference = invoiceReceived
    ? detail.closing.invoiceReceivedAmount -
      detail.closing.invoiceExpectedAmount
    : null;

  const reviewStatusLabel = invoiceReviewStatusLabels[
    reviewStatus as keyof typeof invoiceReviewStatusLabels
  ] ?? (invoiceReceived ? "Nota anexada" : "Aguardando nota");
  const reviewTone = reviewStatus === "approved" || invoiceNotRequired
    ? "success"
    : reviewStatus === "rejected" || reviewStatus === "correction_requested"
      ? "attention"
      : "pending";
  const paymentReady = !detail.closing.invoicePaymentBlock;
  const invoiceJourney = [
    {
      label: "Lançamento",
      value: invoiceNotRequired
        ? "Não se aplica"
        : invoiceReceived
          ? `Lançada${detail.closing.invoiceNumber ? ` · NF ${detail.closing.invoiceNumber}` : ""}`
          : "Não lançada",
      tone: invoiceNotRequired || invoiceReceived ? "success" : "pending",
      Icon: invoiceReceived ? CircleCheckBig : ReceiptText,
    },
    {
      label: "Conferência",
      value: reviewStatusLabel,
      tone: reviewTone,
      Icon: reviewTone === "success" ? CircleCheckBig : reviewTone === "attention" ? CircleAlert : Clock3,
    },
    {
      label: "Pagamento",
      value: paymentReady ? "Liberado" : "Bloqueado pela nota",
      tone: paymentReady ? "success" : "attention",
      Icon: paymentReady ? ShieldCheck : CircleAlert,
    },
  ] as const;

  function downloadCsv() {
    const rows: Array<Array<string | number>> = [
      ["EXTRATO ANALÍTICO DE PAGAMENTO PJ"],
      [],
      ["PJ", detail.provider.legalName],
      ["CNPJ", formatCnpj(detail.provider.taxId)],
      ["Competência", detail.closing.competence],
      ["Contrato", detail.provider.contractReference],
      [],
      ["TIPO", "RUBRICA", "VALOR", "INCIDÊNCIA"],
      ["PROVENTO", detail.closing.prorationDays !== null ? "Valor contratual proporcional" : "Valor contratual", decimal(detail.closing.baseAmount), ""],
      ...credits.map((item) => [
        "PROVENTO",
        item.description || item.componentType,
        decimal(item.amount),
        "",
      ]),
      ["", "TOTAL DE PROVENTOS", decimal(totalEarnings)],
      [],
      ...debits.map((item) => [
        "DESCONTO",
        item.description || item.componentType,
        decimal(item.amount),
        settlementLabels[item.settlementTarget || "auto"] ?? settlementLabels.auto,
      ]),
      ["", "TOTAL DE DESCONTOS", decimal(detail.closing.debitsAmount)],
      ["", "DESCONTOS DENTRO DA NOTA", decimal(debitsOnInvoice)],
      ["", "DESCONTOS NO COMPLEMENTO", decimal(debitsOnComplement)],
      [],
      ["RESUMO", "Líquido devido", decimal(detail.closing.netAmount)],
      ["CAJU", "Complemento Caju", decimal(detail.closing.cajuAmount)],
      [
        "NOTA FISCAL",
        "Valor em Nota Fiscal",
        decimal(detail.closing.invoiceExpectedAmount),
      ],
      [
        "NOTA FISCAL",
        "Valor da NF recebida",
        invoiceReceived
          ? decimal(detail.closing.invoiceReceivedAmount)
          : "",
      ],
      [
        "NOTA FISCAL",
        "Diferença da NF",
        invoiceDifference === null ? "" : decimal(invoiceDifference),
      ],
      [
        "NOTA FISCAL",
        "Número da NF",
        detail.closing.invoiceNumber || "",
      ],
      [
        "NOTA FISCAL",
        "Status da NF",
        reviewStatusLabel,
      ],
      ["PAGAMENTO", "Liberação", paymentReady ? "Liberado" : detail.closing.invoicePaymentBlock],
    ];

    const csv =
      "\uFEFF" +
      rows
        .map((row) => row.map((cell) => csvCell(cell)).join(";"))
        .join("\r\n");

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `extrato-pj-${detail.closing.competence}-${detail.provider.code || detail.provider.id}.csv`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
  }

  return (
    <section
      className={styles.paymentResult}
      aria-labelledby="contractor-analytical-title"
    >
      <header>
        <FileText aria-hidden="true" />
        <h3 id="contractor-analytical-title">
          Resumo da conferência
        </h3>
      </header>

      <p>
        {detail.provider.legalName} · CNPJ{" "}
        {formatCnpj(detail.provider.taxId)} · competência{" "}
        {detail.closing.competence}
      </p>

      <div className={styles.resultGrid}>
        <article>
          <span>Total de proventos</span>
          <strong>{money(totalEarnings)}</strong>
        </article>

        <article data-tone="debit">
          <span>Total de descontos</span>
          <strong>- {money(detail.closing.debitsAmount)}</strong>
          {debitsOnInvoice > 0 || debitsOnComplement > 0 ? (
            <small>
              {debitsOnInvoice > 0 ? `${money(debitsOnInvoice)} dentro da nota` : ""}
              {debitsOnInvoice > 0 && debitsOnComplement > 0 ? " · " : ""}
              {debitsOnComplement > 0 ? `${money(debitsOnComplement)} no complemento` : ""}
            </small>
          ) : null}
        </article>

        <article data-emphasis="true">
          <span>Líquido devido</span>
          <strong>{money(detail.closing.netAmount)}</strong>
        </article>

        <article data-tone="caju">
          <span>
            <WalletCards aria-hidden="true" /> Complemento Caju
          </span>
          <strong>{money(detail.closing.cajuAmount)}</strong>
        </article>

      </div>

      {/* A dica só aparece quando há de fato dois lados para escolher e ninguém
          escolheu: com o pagamento inteiro na nota, a incidência não muda nada
          e o aviso seria ruído. */}
      {splitPayment && detail.closing.debitsAmount > 0 && debitsOnInvoice === 0 && debitsOnComplement === 0 ? (
        <p>
          Este pagamento se divide entre nota fiscal e complemento, e os descontos estão saindo do complemento.
          Se o desconto foi feito dentro do valor da nota, mude a incidência do lançamento na lista de descontos acima.
        </p>
      ) : null}

      <section className={styles.invoiceTracking} aria-labelledby="invoice-tracking-title">
        <header>
          <div>
            <ReceiptText aria-hidden="true" />
            <div>
              <h4 id="invoice-tracking-title">Acompanhamento da nota fiscal</h4>
              <p>Veja o que já foi lançado, o que ainda falta conferir e se o pagamento está liberado.</p>
            </div>
          </div>
          <span className={styles.badge} data-tone={reviewStatus}>{reviewStatusLabel}</span>
        </header>

        <div className={styles.invoiceFacts}>
          <div>
            <span>Valor em Nota Fiscal</span>
            <strong>{money(detail.closing.invoiceExpectedAmount)}</strong>
          </div>
          <div>
            <span>Valor da NF recebida</span>
            <strong>{invoiceReceived ? money(detail.closing.invoiceReceivedAmount) : "Não lançada"}</strong>
          </div>
          <div data-tone={invoiceDifference !== null && Math.abs(invoiceDifference) > 0.01 ? "attention" : undefined}>
            <span>Diferença da NF</span>
            <strong>{invoiceDifference === null ? "—" : money(invoiceDifference)}</strong>
          </div>
          <div>
            <span>Número da NF</span>
            <strong>{detail.closing.invoiceNumber || "Não lançado"}</strong>
          </div>
          <div data-tone={reviewTone}>
            <span>Status da conferência</span>
            <strong>{reviewStatusLabel}</strong>
          </div>
        </div>

        <ol className={styles.invoiceJourney} aria-label="Etapas da nota fiscal">
          {invoiceJourney.map(({ label, value, tone, Icon }) => (
            <li key={label} data-tone={tone}>
              <Icon aria-hidden="true" />
              <span><small>{label}</small><strong>{value}</strong></span>
            </li>
          ))}
        </ol>

        <p className={styles.invoiceRelease} data-ready={paymentReady ? "true" : "false"}>
          {paymentReady
            ? "A nota fiscal não impede o avanço deste pagamento."
            : detail.closing.invoicePaymentBlock}
        </p>
      </section>

      <button
        type="button"
        className={styles.secondaryButton}
        onClick={downloadCsv}
      >
        <Download aria-hidden="true" />
        Exportar extrato CSV
      </button>
    </section>
  );
}
