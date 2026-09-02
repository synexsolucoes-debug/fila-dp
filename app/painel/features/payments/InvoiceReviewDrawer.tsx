"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle, Check, CheckCircle2, Download, ExternalLink, FileText, History,
  LoaderCircle, MessageSquareWarning, RefreshCcw, X, XCircle,
} from "lucide-react";
import {
  contractorInvoiceStatusLabels,
  invoiceChecklistItems,
  invoiceRejectionReasonLabels,
  invoiceRejectionReasons,
  invoiceReviewStatusLabels,
} from "@/lib/contractor-invoices";
import { AnimatedDrawer } from "../shared";
import type { InvoiceDetail } from "./payments.types";
import styles from "./payments.module.css";

const documentUrl = (id: string) => `/api/payments/contractors/documents/${id}`;
const dateTime = (value: string) => (value ? new Date(value).toLocaleString("pt-BR") : "—");
const day = (value: string) => (value ? value.slice(0, 10).split("-").reverse().join("/") : "—");

/** O documento é exibido dentro do sistema; baixar é a alternativa, não o caminho. */
function InvoiceViewer({ detail }: { detail: InvoiceDetail }) {
  const document = detail.document;
  if (!document) {
    return (
      <div className={styles.invoiceViewerEmpty}>
        <FileText aria-hidden="true" />
        <strong>Nenhum arquivo anexado</strong>
        <p>Os dados desta nota foram informados sem o documento. Substitua a nota anexando o arquivo para
          que a conferência possa ser feita sobre ele.</p>
      </div>
    );
  }

  const inline = `${documentUrl(document.id)}?disposition=inline`;
  if (document.contentType === "application/pdf") {
    return <iframe className={styles.invoiceViewerFrame} src={inline} title={`Nota fiscal ${detail.invoice.invoiceNumber}`} />;
  }
  if (document.contentType.startsWith("image/")) {
    /* Imagem enviada por terceiro: entra como `<img>`, nunca como HTML. */
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={styles.invoiceViewerImage} src={inline} alt={`Nota fiscal ${detail.invoice.invoiceNumber}`} />;
  }
  return (
    <div className={styles.invoiceViewerEmpty}>
      <FileText aria-hidden="true" />
      <strong>{document.filename}</strong>
      <p>
        Este formato ({document.contentType || "desconhecido"}) não é exibido dentro do sistema — arquivos que
        podem carregar conteúdo executável só saem como download. Baixe para conferir.
      </p>
      <a className={styles.secondaryButton} href={documentUrl(document.id)}>
        <Download aria-hidden="true" /> Baixar arquivo
      </a>
    </div>
  );
}

type ReviewInput = {
  action: string; checklist: Record<string, boolean>; note: string; reason: string; reasonDetail: string;
};

type DrawerProps = {
  detail: InvoiceDetail | null;
  loading: boolean;
  busy: boolean;
  money: (value: number) => string;
  error: string;
  onClose: () => void;
  onReview: (input: ReviewInput) => void;
  onReplace: () => void;
  onReload: () => void;
};

/**
 * A gaveta de conferência.
 *
 * Tudo que a decisão exige numa tela só: quem é o prestador, quanto o
 * pagamento apurou, o que a nota diz, a diferença entre os dois, o documento
 * visível, o checklist e o histórico das versões anteriores. Sem download
 * intermediário e sem trocar de tela — as duas coisas que faziam a conferência
 * de trinta prestadores levar uma tarde.
 */
export function InvoiceReviewDrawer(props: DrawerProps) {
  const { detail, loading, onClose } = props;
  return (
    <AnimatedDrawer open={Boolean(detail) || loading} onClose={onClose} label="Conferência da nota fiscal" width={720}
      className={`${styles.paymentTokens} ${styles.invoiceDrawer}`}>
      {loading || !detail
        ? (
          <div className={styles.invoiceDrawerLoading} role="status" aria-live="polite">
            <LoaderCircle className={styles.spin} aria-hidden="true" />
            <span>Carregando a nota fiscal…</span>
          </div>
        )
        /* A chave é o identificador da nota, e não um efeito de reinício.
           Trocar de nota recomeça a conferência do zero — manter os itens
           marcados da anterior mostraria como conferido o que ninguém olhou —,
           e é o React quem faz isso quando a identidade do componente muda. */
        : <InvoiceReviewContent key={detail.invoice.id} {...props} detail={detail} />}
    </AnimatedDrawer>
  );
}

function InvoiceReviewContent(
  { detail, busy, money, error, onClose, onReview, onReplace, onReload }: DrawerProps & { detail: InvoiceDetail },
) {
  const [checklist, setChecklist] = useState<Record<string, boolean>>(detail.invoice.checklist ?? {});
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<"reject" | "request_correction" | null>(null);
  const [reason, setReason] = useState<string>(invoiceRejectionReasons[0]);
  const [reasonDetail, setReasonDetail] = useState("");

  const required = useMemo(() => new Set(detail.policy.requiredChecks), [detail.policy.requiredChecks]);
  const missing = useMemo(
    () => [...required].filter((key) => checklist[key] !== true),
    [checklist, required],
  );

  const invoice = detail.invoice;
  const closing = detail.closing;
  const comparison = detail.comparison;
  const decided = invoice.status === "approved" || invoice.status === "rejected" || invoice.status === "correction_requested";

  return (
    <>
      <header className={styles.dialogHeader}>
        <div>
          <span className={styles.eyebrow}>CONFERÊNCIA DE NOTA FISCAL</span>
          <h2>{closing.providerName}</h2>
          <p className={styles.detailMeta}>
            {closing.contractReference || "Contrato sem referência"} · {closing.competence}
            {closing.providerDocument ? ` · ${closing.providerDocument}` : ""}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Fechar conferência"><X aria-hidden="true" /></button>
      </header>

      <div className={styles.invoiceDrawerBody}>
        {!detail.isCurrent && (
          <p className={styles.detailLockedNote}>
            Esta é uma versão anterior da nota deste pagamento. Ela fica preservada para auditoria e não
            pode mais ser conferida.
          </p>
        )}
        {detail.paymentBlock && (
          <p className={styles.invoiceBlockNote}>
            <AlertTriangle aria-hidden="true" />
            {detail.paymentBlock} O pagamento deste prestador está bloqueado.
          </p>
        )}
        {error && <p className={styles.invoiceFormError} role="alert">{error}</p>}

        <section className={styles.invoiceFacts} aria-labelledby="invoice-values-title">
          <h3 id="invoice-values-title">Valores</h3>
          <div className={styles.resultGrid}>
            <article><span>Líquido apurado</span><strong>{money(closing.netAmount)}</strong></article>
            <article><span>Descontos</span><strong>{money(closing.debitsAmount)}</strong></article>
            <article><span>Créditos e adicionais</span><strong>{money(closing.creditsAmount)}</strong></article>
            <article><span>Limite da nota</span>
              <strong>{closing.invoiceLimitAmount === null ? "Sem limite" : money(closing.invoiceLimitAmount)}</strong>
            </article>
            <article><span>Valor esperado da NF</span><strong>{money(comparison.expectedAmount)}</strong></article>
            <article><span>Valor informado na NF</span><strong>{money(comparison.informedAmount)}</strong></article>
            <article data-tone={comparison.matches ? undefined : "debit"} data-emphasis={comparison.matches ? "true" : undefined}>
              <span>Diferença</span>
              <strong>
                {comparison.matches
                  ? "Valor confere"
                  : `${comparison.difference > 0 ? "+" : "−"}${money(Math.abs(comparison.difference))}`}
              </strong>
            </article>
            <article><span>Complemento fora da nota</span><strong>{money(closing.complementAmount)}</strong></article>
          </div>
          {comparison.matches && (
            <p className={styles.hint}>
              Os valores coincidem. A aprovação continua sendo uma decisão sua — o sistema não aprova
              sozinho por igualdade de valores.
            </p>
          )}
        </section>

        <section className={styles.invoiceFacts} aria-labelledby="invoice-data-title">
          <h3 id="invoice-data-title">Dados da nota</h3>
          <dl className={styles.invoiceDataList}>
            <div><dt>Número</dt><dd>{invoice.invoiceNumber || "—"}</dd></div>
            <div><dt>Série</dt><dd>{invoice.series || "—"}</dd></div>
            <div><dt>Emissão</dt><dd>{day(invoice.issueDate)}</dd></div>
            <div><dt>Competência</dt><dd>{invoice.competence}</dd></div>
            <div><dt>CNPJ/CPF do emissor</dt><dd>{invoice.issuerDocument || "—"}</dd></div>
            <div><dt>Razão social do emissor</dt><dd>{invoice.issuerName || "—"}</dd></div>
            <div><dt>CNPJ do tomador</dt><dd>{invoice.receiverDocument || closing.companyDocument || "—"}</dd></div>
            <div><dt>Empresa pagadora</dt><dd>{closing.companyName || "—"}</dd></div>
            <div><dt>Serviço</dt><dd>{invoice.serviceDescription || "—"}</dd></div>
            <div><dt>Enviada em</dt><dd>{dateTime(invoice.uploadedAt)}</dd></div>
            <div><dt>Situação</dt>
              <dd><span className={styles.badge} data-tone={invoice.status}>
                {contractorInvoiceStatusLabels[invoice.status as keyof typeof contractorInvoiceStatusLabels] ?? invoice.status}
              </span></dd>
            </div>
            <div><dt>Conferida em</dt><dd>{dateTime(invoice.reviewedAt)}</dd></div>
          </dl>
          {invoice.notes && <p className={styles.hint}>Observação do envio: {invoice.notes}</p>}
          {invoice.rejectionReason && (
            <p className={styles.invoiceRejectionNote}>
              Motivo registrado: {invoiceRejectionReasonLabels[invoice.rejectionReason as keyof typeof invoiceRejectionReasonLabels] ?? invoice.rejectionReason}
              {invoice.rejectionDetail ? ` — ${invoice.rejectionDetail}` : ""}
            </p>
          )}
        </section>

        <section className={styles.invoiceFacts} aria-labelledby="invoice-document-title">
          <header className={styles.invoiceSectionHeader}>
            <h3 id="invoice-document-title">Documento</h3>
            {detail.document && (
              <div className={styles.documentActions}>
                <a href={`${documentUrl(detail.document.id)}?disposition=inline`} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" /> Abrir em nova aba
                </a>
                <a href={documentUrl(detail.document.id)}><Download aria-hidden="true" /> Baixar</a>
              </div>
            )}
          </header>
          <InvoiceViewer detail={detail} />
        </section>

        {detail.isCurrent && !decided && (detail.permissions.approve || detail.permissions.reject) && (
          <section className={styles.invoiceFacts} aria-labelledby="invoice-checklist-title">
            <h3 id="invoice-checklist-title">Checklist de conferência</h3>
            <p className={styles.hint}>
              {required.size === 0
                ? "Apoio para não deixar item passar. Nenhum é obrigatório nas configurações deste grupo."
                : `${required.size} item(ns) marcado(s) como obrigatório(s) para aprovar nas configurações deste grupo.`}
            </p>
            <ul className={styles.invoiceChecklist}>
              {invoiceChecklistItems.map((item) => (
                <li key={item.key}>
                  <label>
                    <input type="checkbox" checked={checklist[item.key] === true}
                      onChange={(event) => setChecklist((current) => ({ ...current, [item.key]: event.target.checked }))} />
                    {item.label}
                    {required.has(item.key) && <b aria-label="obrigatório"> *</b>}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.invoiceFacts} aria-labelledby="invoice-versions-title">
          <h3 id="invoice-versions-title">Versões desta nota</h3>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className={styles.tableCaption}>Envios registrados para este pagamento</caption>
              <thead>
                <tr>
                  <th scope="col">Envio</th><th scope="col">Número</th><th scope="col">Valor</th>
                  <th scope="col">Situação</th><th scope="col">Arquivo</th>
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((version) => (
                  <tr key={version.id} aria-current={version.id === invoice.id ? "true" : undefined}>
                    <th scope="row">#{version.attempt}<small>{dateTime(version.uploadedAt)}</small></th>
                    <td>{version.invoiceNumber}{version.series ? `/${version.series}` : ""}</td>
                    <td>{money(version.amount)}</td>
                    <td><span className={styles.badge} data-tone={version.status}>
                      {contractorInvoiceStatusLabels[version.status as keyof typeof contractorInvoiceStatusLabels] ?? version.status}
                    </span></td>
                    <td>
                      {version.documentId
                        ? <a className={styles.detailActionHint} href={`${documentUrl(version.documentId)}?disposition=inline`} target="_blank" rel="noreferrer">Ver arquivo</a>
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.invoiceFacts} aria-labelledby="invoice-history-title">
          <h3 id="invoice-history-title"><History aria-hidden="true" /> Histórico</h3>
          {detail.events.length === 0 ? (
            <p className={styles.hint}>Nenhum evento registrado ainda.</p>
          ) : (
            <ol className={styles.invoiceTimeline}>
              {detail.events.map((event) => (
                <li key={event.id}>
                  <span className={styles.badge} data-tone={event.action}>{event.action}</span>
                  <div>
                    <strong>{event.summary}</strong>
                    <small>{dateTime(event.createdAt)}{event.actorName ? ` · ${event.actorName}` : ""}</small>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <footer className={styles.invoiceDrawerFooter}>
        {decision ? (
          <form
            className={styles.invoiceDecisionForm}
            onSubmit={(event) => {
              event.preventDefault();
              onReview({ action: decision, checklist, note, reason, reasonDetail });
            }}
          >
            <label>Motivo
              <select value={reason} onChange={(event) => setReason(event.target.value)}>
                {invoiceRejectionReasons.map((item) => (
                  <option key={item} value={item}>{invoiceRejectionReasonLabels[item]}</option>
                ))}
              </select>
            </label>
            <label>Descrição{reason === "other" ? " (obrigatória)" : ""}
              <input value={reasonDetail} maxLength={500} required={reason === "other"}
                onChange={(event) => setReasonDetail(event.target.value)}
                placeholder="O que o prestador precisa corrigir" />
            </label>
            <div className={styles.invoiceDecisionActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => setDecision(null)} disabled={busy}>
                Voltar
              </button>
              <button type="submit" className={styles.primaryButton} disabled={busy}>
                {busy ? "Registrando…" : decision === "reject" ? "Confirmar rejeição" : "Confirmar solicitação"}
              </button>
            </div>
          </form>
        ) : (
          <div className={styles.invoiceDrawerActions}>
            <button type="button" className={styles.secondaryButton} onClick={onReload} disabled={busy}>
              <RefreshCcw aria-hidden="true" /> Atualizar
            </button>
            {detail.isCurrent && detail.permissions.replace && (
              <button type="button" className={styles.secondaryButton} onClick={onReplace} disabled={busy}>
                <RefreshCcw aria-hidden="true" /> Substituir nota
              </button>
            )}
            {detail.isCurrent && !decided && detail.permissions.reject && (
              <>
                <button type="button" className={styles.secondaryButton} onClick={() => setDecision("request_correction")} disabled={busy}>
                  <MessageSquareWarning aria-hidden="true" /> Solicitar correção
                </button>
                <button type="button" className={styles.secondaryButton} onClick={() => setDecision("reject")} disabled={busy}>
                  <XCircle aria-hidden="true" /> Rejeitar nota
                </button>
              </>
            )}
            {detail.isCurrent && !decided && detail.permissions.approve && (
              <button type="button" className={styles.primaryButton} disabled={busy || missing.length > 0}
                onClick={() => onReview({ action: "approve", checklist, note, reason: "", reasonDetail: "" })}>
                <CheckCircle2 aria-hidden="true" /> {busy ? "Aprovando…" : "Aprovar nota"}
              </button>
            )}
            {decided && (
              <span className={styles.invoiceDecidedNote}>
                <Check aria-hidden="true" />
                {invoiceReviewStatusLabels[invoice.status as keyof typeof invoiceReviewStatusLabels] ?? invoice.status}
                {invoice.reviewedAt ? ` em ${dateTime(invoice.reviewedAt)}` : ""}
              </span>
            )}
          </div>
        )}
        {missing.length > 0 && !decision && (
          <p className={styles.hint}>
            Faltam {missing.length} item(ns) obrigatório(s) do checklist para liberar a aprovação.
          </p>
        )}
        <label className={styles.invoiceNoteField}>
          Anotação da conferência
          <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)}
            placeholder="Opcional — fica no histórico da nota" />
        </label>
  </footer>
    </>
  );
}
