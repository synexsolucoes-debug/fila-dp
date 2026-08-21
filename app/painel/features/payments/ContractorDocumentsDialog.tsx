"use client";

import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, FileText, FolderOpen, LoaderCircle, X } from "lucide-react";
import { requestJson, type Row } from "./payments.api";
import type { ContractorDocument } from "./payments.types";
import styles from "./payments.module.css";

type Props = {
  providerId: string;
  providerName: string;
  contractReference: string;
  onClose: () => void;
};

const value = (row: Row, camel: string, snake: string) => row[camel] ?? row[snake];
const fileSize = (bytes: number) => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function ContractorDocumentsDialog({ providerId, providerName, contractReference, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [documents, setDocuments] = useState<ContractorDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    let active = true;
    void requestJson<{ documents?: Row[] }>(`/api/payments/contractors/${providerId}/documents`)
      .then((payload) => {
        if (!active) return;
        setDocuments((payload.documents ?? []).map((row) => ({
          id: String(row.id ?? ""),
          closingId: String(value(row, "closingId", "closing_id") ?? ""),
          documentKind: String(value(row, "documentKind", "document_kind") ?? "invoice"),
          competence: String(row.competence ?? ""),
          invoiceNumber: String(value(row, "invoiceNumber", "invoice_number") ?? ""),
          filename: String(row.filename ?? ""),
          contentType: String(value(row, "contentType", "content_type") ?? ""),
          sizeBytes: Number(value(row, "sizeBytes", "size_bytes") ?? 0),
          createdAt: String(value(row, "createdAt", "created_at") ?? ""),
        })));
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar os arquivos."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [providerId]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();
    const selector = "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
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
      <div className={`${styles.dialog} ${styles.documentsDialog}`} ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="contract-documents-title" tabIndex={-1}>
        <header className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>ARQUIVOS DO CONTRATO</span>
            <h2 id="contract-documents-title">Documentos de {providerName}</h2>
            <p>{contractReference || "Contrato sem referência informada"}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar documentos"><X aria-hidden="true" /></button>
        </header>

        <div className={styles.documentsBody}>
          {loading ? <p className={styles.loadingLine}><LoaderCircle className={styles.spin} aria-hidden="true" /> Carregando arquivos…</p> : null}
          {error ? <p className={styles.warningState}>{error}</p> : null}
          {!loading && !error && documents.length === 0 ? (
            <div className={styles.documentsEmpty}>
              <FolderOpen aria-hidden="true" />
              <strong>Nenhuma nota fiscal anexada</strong>
              <p>Use a ação “Nota” no pagamento para registrar a nota e guardar o arquivo neste contrato.</p>
            </div>
          ) : null}
          {documents.length > 0 ? (
            <ul className={styles.documentList}>
              {documents.map((document) => {
                const url = `/api/payments/contractors/documents/${document.id}`;
                return (
                  <li key={document.id}>
                    <span className={styles.documentIcon}><FileText aria-hidden="true" /></span>
                    <div>
                      <strong>{document.filename}</strong>
                      <span>Nota fiscal {document.invoiceNumber || "sem número"} · competência {document.competence}</span>
                      <small>{fileSize(document.sizeBytes)} · anexada em {document.createdAt ? new Date(document.createdAt).toLocaleDateString("pt-BR") : "—"}</small>
                    </div>
                    <div className={styles.documentActions}>
                      <a href={`${url}?disposition=inline`} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /> Visualizar</a>
                      <a href={url}><Download aria-hidden="true" /> Baixar</a>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        <footer className={styles.dialogFooter}><span /><button className={styles.primaryButton} type="button" onClick={onClose}>Fechar</button></footer>
      </div>
    </div>
  );
}
