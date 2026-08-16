"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertOctagon, Download, FileUp, LoaderCircle, RefreshCw } from "lucide-react";
import { requestJson } from "./payments.api";
import { ErrorBanner } from "../shared";
import styles from "./payments.module.css";

/**
 * Exportação da diferença PJ para o cartão de benefício.
 *
 * O painel existe porque a exportação depende de duas coisas que o produto não
 * pode inventar: o modelo oficial baixado do portal da Caju e a conferência do
 * que entra no arquivo. Sem modelo, o botão não fica escondido — ele explica o
 * que falta. Com registro bloqueado, o arquivo não é gerado pela metade.
 */

type TemplateInfo = {
  version: number;
  fileName: string;
  categoryKey: string;
  categoryLabel: string;
  amountLabel: string;
  columns: string[];
  format: string;
  activatedAt: string | null;
};

type PreviewRow = { contractorId: string; contractorName: string; amountCents: number };
type BlockedRow = { contractorId: string; contractorName: string; reason: string; reasonLabel: string };

type Preview = {
  template: { version: number; categoryKey: string; amountLabel: string; format: string } | null;
  eligible: PreviewRow[];
  blocked: BlockedRow[];
  skippedZero: number;
  totalCents: number;
  canExport: boolean;
};

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function CajuExportPanel({ competenceId, canExport }: { competenceId: string; canExport: boolean }) {
  const [template, setTemplate] = useState<TemplateInfo | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [catalog, previewPayload] = await Promise.all([
        requestJson<{ active: TemplateInfo | null }>("/api/payments/caju/templates"),
        requestJson<Preview>(`/api/payments/caju/export?competenceId=${encodeURIComponent(competenceId)}`),
      ]);
      setTemplate(catalog.active);
      setPreview(previewPayload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a exportação.");
    } finally {
      setLoading(false);
    }
  }, [competenceId]);

  // Mesmo padrão do resto do painel: a carga sai do corpo do efeito para o
  // próximo frame, senão o `setLoading(true)` roda durante a renderização.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function uploadTemplate(file: File) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = new FormData();
      body.append("file", file);
      // Sem `Content-Type`: o browser precisa montar o boundary do multipart.
      const response = await fetch("/api/payments/caju/templates", { method: "POST", body, cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { template?: TemplateInfo; message?: string; error?: string };
      if (!response.ok) throw new Error(payload.message || payload.error || "Não foi possível cadastrar o modelo.");
      setNotice(payload.template
        ? `Modelo v${payload.template.version} ativo — ${payload.template.categoryLabel}.`
        : "Modelo cadastrado.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível cadastrar o modelo.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function download() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/payments/caju/export?competenceId=${encodeURIComponent(competenceId)}`,
        { method: "POST", cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
        throw new Error(payload.message || payload.error || "Não foi possível gerar o arquivo.");
      }
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const suggested = /filename="([^"]+)"/u.exec(disposition)?.[1] ?? "caju.csv";
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = suggested;
      anchor.click();
      URL.revokeObjectURL(url);
      // O total sai no cabeçalho para conferir contra a tela sem reabrir o arquivo.
      const rows = response.headers.get("X-Caju-Rows") ?? "?";
      const total = Number(response.headers.get("X-Caju-Total-Cents") ?? 0);
      setNotice(`Arquivo gerado: ${rows} linha(s), total ${money(total)}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerar o arquivo.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className={`${styles.cajuPanel} ${styles.cajuLoading}`} aria-busy="true">
        <LoaderCircle className={styles.spin} aria-hidden="true" /> Carregando a exportação da Caju…
      </section>
    );
  }

  return (
    <section className={styles.cajuPanel} aria-label="Exportação para a Caju">
      <header>
        <span className={styles.eyebrow}>EXPORTAÇÃO CAJU</span>
        {template ? (
          <p className={styles.hint}>
            Modelo oficial v{template.version} — <b>{template.categoryLabel}</b>. Colunas: {template.columns.join(" · ")}.
          </p>
        ) : (
          <p className={styles.hint}>
            Nenhum modelo oficial cadastrado. Baixe a planilha de pedidos no portal da Caju e envie aqui — o arquivo de
            exportação é gerado a partir dela, não de um layout aproximado.
          </p>
        )}
      </header>

      {preview && (
        <div className={styles.summaryGrid}>
          <article><span>Vão para o arquivo</span><strong>{preview.eligible.length}</strong></article>
          <article><span>Total a creditar</span><strong>{money(preview.totalCents)}</strong></article>
          <article data-alert={preview.blocked.length > 0 ? "true" : "false"}>
            <span>Bloqueados</span><strong>{preview.blocked.length}</strong>
          </article>
          <article><span>Sem diferença</span><strong>{preview.skippedZero}</strong></article>
        </div>
      )}

      {preview && preview.blocked.length > 0 && (
        <div className={`${styles.warningState} ${styles.cajuBlocked}`} role="alert">
          <AlertOctagon aria-hidden="true" />
          <div>
            <strong>{preview.blocked.length} registro(s) impedem o arquivo.</strong>
            <ul>
              {preview.blocked.map((row) => (
                <li key={row.contractorId}>{row.contractorName} — {row.reasonLabel}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {template && preview?.template && template.categoryKey !== "saldo_livre" && (
        <p className={styles.hint} role="status">
          O modelo ativo é de <b>{template.categoryLabel}</b>. Exportar a diferença PJ com o modelo de outra categoria
          credita o benefício errado — confira se é essa a intenção.
        </p>
      )}

      {error && <ErrorBanner message={error} />}
      {notice && <p className={styles.hint} role="status">{notice}</p>}

      <div className={styles.cajuActions}>
        <button type="button" className={styles.secondaryButton} onClick={() => void load()} disabled={busy}>
          <RefreshCw aria-hidden="true" /> Reconferir
        </button>
        {canExport && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadTemplate(file);
              }}
            />
            <button type="button" className={styles.secondaryButton} onClick={() => fileInput.current?.click()} disabled={busy}>
              <FileUp aria-hidden="true" /> {template ? "Substituir modelo" : "Cadastrar modelo oficial"}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void download()}
              disabled={busy || !preview?.canExport}
              // Botão desabilitado sem explicação vira suporte: o motivo fica no título.
              title={preview?.canExport ? "Gerar o arquivo de pedidos" : "Cadastre o modelo oficial e resolva os bloqueios acima"}
            >
              {busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Download aria-hidden="true" />}
              Gerar arquivo
            </button>
          </>
        )}
      </div>
    </section>
  );
}
