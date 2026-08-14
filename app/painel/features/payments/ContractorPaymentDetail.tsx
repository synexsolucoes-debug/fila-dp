"use client";

import { useEffect, useMemo, useRef } from "react";
import { ArrowDownRight, ArrowUpRight, FileText, WalletCards, X } from "lucide-react";
import type { ContractorComponent, ContractorPaymentDetail as Detail } from "./payments.types";
import styles from "./payments.module.css";

const componentLabels: Record<string, string> = {
  base: "Salário-base",
  commission: "Comissão",
  bonus: "Bônus",
  award: "Prêmio",
  reimbursement: "Reembolso",
  additional: "Adicional",
  positive_adjustment: "Ajuste positivo",
  other_credit: "Outro provento",
  health_plan: "Plano de saúde",
  dental_plan: "Plano odontológico",
  benefit: "Convênio ou benefício",
  coparticipation: "Coparticipação",
  equipment: "Equipamento",
  advance: "Adiantamento",
  absence: "Falta",
  loan: "Empréstimo",
  negative_adjustment: "Ajuste negativo",
  other_debit: "Outro desconto",
};

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

function ComponentRows({ rows }: { rows: ContractorComponent[] }) {
  if (rows.length === 0) {
    return <tr><td colSpan={4} className={styles.detailEmpty}>Nenhum lançamento nesta competência.</td></tr>;
  }
  return rows.map((item) => (
    <tr key={item.id} data-canceled={item.status === "canceled" ? "true" : "false"}>
      <td>{item.description || componentLabels[item.componentType] || item.componentType}</td>
      <td>{originLabels[item.origin] || item.origin}</td>
      <td>{item.status === "canceled" ? "Cancelado" : "Ativo"}</td>
      <td>{money(item.amount)}</td>
    </tr>
  ));
}

export function ContractorPaymentDetail({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const credits = useMemo(() => detail.components.filter((item) => item.direction === "credit"), [detail.components]);
  const debits = useMemo(() => detail.components.filter((item) => item.direction === "debit"), [detail.components]);
  const earnings = detail.closing.baseAmount + detail.closing.creditsAmount;

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const selector = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
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
            <span className={styles.eyebrow}>DETALHAMENTO DO PAGAMENTO PJ</span>
            <h2 id="contractor-payment-detail-title">{detail.provider.legalName}</h2>
            <p className={styles.detailMeta}>
              {detail.provider.roleTitle || detail.provider.contractReference || detail.provider.code} · competência {detail.closing.competence}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar detalhamento"><X aria-hidden="true" /></button>
        </header>

        <div className={styles.detailBody}>
          <section className={styles.paymentBreakdown} data-tone="credit" aria-labelledby="earnings-title">
            <header>
              <div><ArrowUpRight aria-hidden="true" /><h3 id="earnings-title">Proventos</h3></div>
              <strong>{money(earnings)}</strong>
            </header>
            <div className={styles.tableScroll}>
              <table className={styles.detailTable}>
                <thead><tr><th scope="col">Rubrica</th><th scope="col">Origem</th><th scope="col">Situação</th><th scope="col">Valor</th></tr></thead>
                <tbody>
                  <tr><td>Salário-base</td><td>Contratual</td><td>Ativo</td><td>{money(detail.closing.baseAmount)}</td></tr>
                  <ComponentRows rows={credits} />
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
                <thead><tr><th scope="col">Rubrica</th><th scope="col">Origem</th><th scope="col">Situação</th><th scope="col">Valor</th></tr></thead>
                <tbody><ComponentRows rows={debits} /></tbody>
              </table>
            </div>
          </section>

          <section className={styles.paymentResult} aria-labelledby="payment-result-title">
            <header><FileText aria-hidden="true" /><h3 id="payment-result-title">Resultado final</h3></header>
            <div className={styles.resultGrid}>
              <article><span>Proventos</span><strong>{money(earnings)}</strong></article>
              <article data-tone="debit"><span>Descontos</span><strong>- {money(detail.closing.debitsAmount)}</strong></article>
              <article data-emphasis="true"><span>Líquido devido</span><strong>{money(detail.closing.netAmount)}</strong></article>
              <article><span>Nota a emitir</span><strong>{money(detail.closing.invoiceExpectedAmount)}</strong></article>
              <article><span>Complemento total</span><strong>{money(detail.closing.complementAmount)}</strong></article>
              <article data-tone="caju"><span><WalletCards aria-hidden="true" /> Caju Saldo Livre</span><strong>{money(detail.closing.cajuAmount)}</strong></article>
            </div>
            <p>Proventos − descontos = líquido devido. O limite da nota separa o valor da NF do complemento destinado à Caju.</p>
          </section>
        </div>

        <footer className={styles.dialogFooter}>
          <button className={styles.primaryButton} type="button" onClick={onClose}>Fechar</button>
        </footer>
      </div>
    </div>
  );
}
