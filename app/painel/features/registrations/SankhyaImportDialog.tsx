"use client";

import { FormEvent, useMemo, useState } from "react";
import { Check, FileSpreadsheet, LoaderCircle, Upload, X } from "lucide-react";
import type { Company } from "./registrations.types";
import styles from "./registrations.module.css";

type Classification = "new" | "changed" | "unchanged" | "conflict";
type Preview = {
  summary: Record<Classification, number>;
  items: Array<{
    externalId: string;
    registrationNumber: string;
    fullName: string;
    cpfLast4: string;
    admissionDate: string;
    terminationDate: string;
    classification: Classification;
  }>;
};

const labels: Record<Classification, string> = {
  new: "Novos",
  changed: "Atualizados",
  unchanged: "Sem alteração",
  conflict: "Conflitos",
};

async function send(file: File, companyId: string, action: "preview" | "import") {
  const body = new FormData();
  body.set("file", file);
  body.set("companyId", companyId);
  body.set("action", action);
  const response = await fetch("/api/employees/import/sankhya", { method: "POST", body, cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as Preview & { error?: string; message?: string; created?: number; updated?: number; unchanged?: number; conflicts?: number };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível analisar a planilha.");
  return payload;
}

function companyName(company: Company) { return company.tradeName || company.legalName; }

export function SankhyaImportDialog({ companies, initialCompanyId, onClose, onImported }: {
  companies: Company[];
  initialCompanyId: string;
  onClose: () => void;
  onImported: (message: string) => Promise<void>;
}) {
  const availableCompanies = useMemo(() => companies.filter((company) => company.status === "active"), [companies]);
  const [companyId, setCompanyId] = useState(initialCompanyId || availableCompanies[0]?.id || "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState("");

  async function previewFile(event: FormEvent) {
    event.preventDefault();
    if (!file || !companyId) return;
    setBusy("preview"); setError("");
    try { setPreview(await send(file, companyId, "preview")); }
    catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : "Planilha inválida."); }
    finally { setBusy(null); }
  }

  async function importFile() {
    if (!file || !companyId || !preview) return;
    setBusy("import"); setError("");
    try {
      const result = await send(file, companyId, "import");
      await onImported(`${result.created ?? 0} colaborador(es) criado(s) e ${result.updated ?? 0} atualizado(s).`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível importar a planilha."); setBusy(null); }
  }

  return <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className={styles.importDialog} role="dialog" aria-modal="true" aria-labelledby="sankhya-import-title">
      <header><div><span>IMPORTAÇÃO DE COLABORADORES</span><h2 id="sankhya-import-title">Modelo Sankhya</h2><p>Compare a planilha com o cadastro atual antes de gravar qualquer alteração.</p></div><button type="button" onClick={onClose} disabled={Boolean(busy)} aria-label="Fechar"><X /></button></header>
      <form onSubmit={previewFile} className={styles.importSetup}>
        <label><span>Empresa de destino</span><select value={companyId} onChange={(event) => { setCompanyId(event.target.value); setPreview(null); }} required>{availableCompanies.map((company) => <option key={company.id} value={company.id}>{companyName(company)}</option>)}</select></label>
        <label className={styles.filePicker}><span>Planilha .xlsx</span><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(""); }} required /><div><FileSpreadsheet /><span><strong>{file?.name || "Selecionar arquivo Sankhya"}</strong><small>{file ? `${(file.size / 1024).toFixed(0)} KB` : "Até 10 MB · modelo Resultado da Query"}</small></span><Upload /></div></label>
        {error && <p className={styles.importError}>{error}</p>}
        <button className={styles.secondaryButton} disabled={!file || !companyId || Boolean(busy)}>{busy === "preview" ? <LoaderCircle className={styles.spin} /> : <FileSpreadsheet />} Analisar e comparar</button>
      </form>
      {preview && <div className={styles.importPreview}>
        <div className={styles.importSummary}>{(["new", "changed", "unchanged", "conflict"] as Classification[]).map((item) => <article key={item} data-status={item}><strong>{preview.summary[item]}</strong><span>{labels[item]}</span></article>)}</div>
        <div className={styles.importGuidance}><Check /><p><strong>Nenhuma alteração foi gravada ainda.</strong><span>Novos serão cadastrados, alterados serão sincronizados e conflitos serão ignorados para revisão.</span></p></div>
        <div className={styles.importTableWrap}><table className={styles.importTable}><thead><tr><th>Colaborador</th><th>Matrícula</th><th>CPF</th><th>Admissão</th><th>Resultado</th></tr></thead><tbody>{preview.items.map((item) => <tr key={item.externalId}><td><strong>{item.fullName}</strong><small>Sankhya {item.externalId}</small></td><td>{item.registrationNumber}</td><td>{item.cpfLast4 ? `•••-${item.cpfLast4}` : "Não informado"}</td><td>{item.admissionDate}</td><td><span className={styles.importStatus} data-status={item.classification}>{labels[item.classification]}</span></td></tr>)}</tbody></table></div>
      </div>}
      <footer><span>{preview ? `${preview.items.length} registro(s) exibido(s) na prévia` : "A importação não apaga colaboradores existentes."}</span><button type="button" className={styles.secondaryButton} onClick={onClose} disabled={Boolean(busy)}>Cancelar</button><button type="button" className={styles.primaryButton} onClick={() => void importFile()} disabled={!preview || Boolean(busy) || (preview.summary.new + preview.summary.changed === 0)}>{busy === "import" ? <LoaderCircle className={styles.spin} /> : <Upload />} Importar selecionados</button></footer>
    </section>
  </div>;
}
