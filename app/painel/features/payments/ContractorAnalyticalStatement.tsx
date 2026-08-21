"use client";

import { Download, FileText, WalletCards } from "lucide-react";
import type { ContractorPaymentDetail as Detail } from "./payments.types";
import styles from "./payments.module.css";

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value || 0);

const decimal = (value: number) =>
  Number(value || 0).toFixed(2).replace(".", ",");

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

const invoiceStatusLabels: Record<string, string> = {
  pending: "Pendente",
  received: "Recebida",
  validated: "Conferida",
  divergent: "Divergente",
  not_required: "Não se aplica",
  canceled: "Cancelada",
};

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

  const invoiceReceived =
    detail.closing.invoiceStatus === "received" ||
    detail.closing.invoiceStatus === "validated" ||
    detail.closing.invoiceStatus === "divergent";

  const invoiceDifference = invoiceReceived
    ? detail.closing.invoiceExpectedAmount -
      detail.closing.invoiceReceivedAmount
    : null;

  const conferenceStatus = !invoiceReceived
    ? "Pendente NF"
    : Math.abs(invoiceDifference ?? 0) <= 0.01
      ? "OK"
      : "Divergente";

  function downloadCsv() {
    const rows: Array<Array<string | number>> = [
      ["EXTRATO ANALÍTICO DE PAGAMENTO PJ"],
      [],
      ["PJ", detail.provider.legalName],
      ["CNPJ", formatCnpj(detail.provider.taxId)],
      ["Competência", detail.closing.competence],
      ["Contrato", detail.provider.contractReference],
      [],
      ["TIPO", "RUBRICA", "VALOR"],
      ["PROVENTO", detail.closing.prorationDays !== null ? "Valor contratual proporcional" : "Valor contratual", decimal(detail.closing.baseAmount)],
      ...credits.map((item) => [
        "PROVENTO",
        item.description || item.componentType,
        decimal(item.amount),
      ]),
      ["", "TOTAL DE PROVENTOS", decimal(totalEarnings)],
      [],
      ...debits.map((item) => [
        "DESCONTO",
        item.description || item.componentType,
        decimal(item.amount),
      ]),
      ["", "TOTAL DE DESCONTOS", decimal(detail.closing.debitsAmount)],
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
        invoiceStatusLabels[detail.closing.invoiceStatus] ||
          detail.closing.invoiceStatus,
      ],
      ["CONFERÊNCIA", "Status", conferenceStatus],
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

        <article>
          <span>Valor em Nota Fiscal</span>
          <strong>
            {money(detail.closing.invoiceExpectedAmount)}
          </strong>
        </article>

        <article>
          <span>Valor da NF recebida</span>
          <strong>
            {invoiceReceived
              ? money(detail.closing.invoiceReceivedAmount)
              : "Pendente"}
          </strong>
        </article>

        <article
          data-tone={
            invoiceDifference !== null &&
            Math.abs(invoiceDifference) > 0.01
              ? "debit"
              : undefined
          }
        >
          <span>Diferença da NF</span>
          <strong>
            {invoiceDifference === null
              ? "—"
              : money(invoiceDifference)}
          </strong>
        </article>

        <article>
          <span>Número da NF</span>
          <strong>{detail.closing.invoiceNumber || "Pendente"}</strong>
        </article>

        <article>
          <span>Status da conferência</span>
          <strong>{conferenceStatus}</strong>
        </article>
      </div>

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
